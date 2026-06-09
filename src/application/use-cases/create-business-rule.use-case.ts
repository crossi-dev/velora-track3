import type { BusinessRuleRepositoryPort, BusinessRuleRecord, BusinessRuleClassification } from "@/domain/ports/business-rule.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import { DemoLimitReachedError } from "@/app/api/_lib/demo-quota";
import { validateTimeTrigger, validateConditionTrigger } from "@/domain/rules/cron-validation";

export interface CreateBusinessRuleInput {
  businessId: string;
  actorUserId: string;
  kind?: string;
  trigger: string;
  message: string;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
  /**
   * When true, a duplicate trigger is resolved as an upsert (update existing rule)
   * rather than returning duplicate_trigger. Used by the Supervisor caller — the
   * REST route (route.ts) never passes this flag, so it never sees outcome "upserted".
   */
  allowUpsertByTrigger?: boolean;
}

export type CreateBusinessRuleResult =
  | { outcome: "created"; rule: BusinessRuleRecord }
  | { outcome: "upserted"; rule: BusinessRuleRecord }
  | { outcome: "duplicate_trigger"; existingId: string }
  | { outcome: "invalid_trigger"; message: string }
  | { outcome: "demo_limit_reached" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  businessRule: BusinessRuleRepositoryPort;
  idempotency: IdempotencyPort;
  classifier: (message: string) => Promise<BusinessRuleClassification>;
  audit: AuditPort;
  /** Optional: injected for demo-quota enforcement. No-op when omitted. */
  assertDemoQuota?: (businessId: string) => Promise<void>;
  /** Optional: notify active employees of a new/updated rule. No-op when omitted. */
  notifyRuleEmployees?: (businessId: string, ruleId: string, body: string) => Promise<void>;
  /** Optional: invalidate supervisor context cache after rule write. No-op when omitted. */
  invalidateSupervisorContext?: (businessId: string) => void;
}

export function createBusinessRuleUseCase(ports: Ports) {
  return {
    async execute(input: CreateBusinessRuleInput): Promise<CreateBusinessRuleResult> {
      const {
        businessId, actorUserId, kind: inputKind, trigger, message,
        idempotencyKey, requestBody, actionMeta, allowUpsertByTrigger,
      } = input;

      const idempotency = await ports.idempotency.begin({
        businessId,
        actionType: actionMeta.actionType,
        idempotencyKey,
        requestBody,
      });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      // Bug5 pattern: assertDemoQuota after begin so replays of already-counted actions pass through.
      if (ports.assertDemoQuota) {
        try {
          await ports.assertDemoQuota(businessId);
        } catch (e) {
          if (e instanceof DemoLimitReachedError) {
            await ports.idempotency.release(recordId);
            return { outcome: "demo_limit_reached" };
          }
          await ports.idempotency.release(recordId);
          throw e;
        }
      }

      // If the supervisor already classified the rule (explicit kind), trust it and
      // skip the classifier — the classifier is only a fallback for user-typed rules
      // where kind is undefined. This prevents the classifier from overwriting a
      // deliberate supervisor decision (Q8 B-1).
      let finalKind: string;
      let finalTrigger: string;
      if (inputKind === "time-based" || inputKind === "condition-based" || inputKind === "behavior-based") {
        finalKind = inputKind;
        finalTrigger = trigger.trim();
      } else {
        const classification = await ports.classifier(message.trim());
        const isCondition = classification.kind === "condition-based";
        finalKind = isCondition ? "condition-based" : classification.kind;
        finalTrigger = classification.trigger ?? classification.cron ?? trigger.trim();
      }

      // Validate trigger format for enforceable rule kinds.
      let triggerError: string | null = null;
      if (finalKind === "time-based") {
        triggerError = validateTimeTrigger(finalTrigger);
      } else if (finalKind === "condition-based") {
        triggerError = validateConditionTrigger(finalTrigger);
      }
      if (triggerError !== null) {
        await ports.idempotency.release(recordId);
        return { outcome: "invalid_trigger", message: triggerError };
      }

      const existing = await ports.businessRule.findByTrigger(businessId, finalTrigger);

      // allowUpsertByTrigger: supervisor callers resolve duplicate trigger as an update
      // (upsert semantics). The REST route never passes this flag — it stays on the
      // duplicate_trigger branch, preserving its existing 409 behavior (frozen contract).
      if (existing && allowUpsertByTrigger) {
        let upserted: BusinessRuleRecord | null;
        try {
          upserted = await ports.businessRule.update(businessId, existing.id, { kind: finalKind, message: message.trim(), active: true });
        } catch (err) {
          await ports.idempotency.release(recordId);
          throw err;
        }
        if (!upserted) {
          await ports.idempotency.release(recordId);
          return { outcome: "duplicate_trigger", existingId: existing.id };
        }
        await ports.idempotency.complete(null, recordId, 200, { rule: { id: upserted.id, kind: upserted.kind, trigger: upserted.trigger } });
        try {
          await ports.notifyRuleEmployees?.(businessId, upserted.id, `Regla actualizada: ${message.trim()}`);
        } catch (notifyErr) {
          // notify failure is non-fatal — rule already persisted + idempotency sealed
          void notifyErr;
        }
        ports.invalidateSupervisorContext?.(businessId);
        try {
          await ports.audit.recordCriticalWrite({
            businessId, actorUserId, actorEmployeeId: null,
            routeScope: actionMeta.routeScope, actionType: actionMeta.actionType, resourceType: actionMeta.resourceType,
            resourceId: upserted.id,
            summary: `Actualizó regla de negocio (trigger duplicado): "${message.trim().slice(0, 60)}"`,
            payload: { ruleId: upserted.id, kind: finalKind, trigger: finalTrigger, wasExisting: true },
          });
        } catch { /* audit gap — absorb */ }
        return { outcome: "upserted", rule: upserted };
      }

      if (existing) {
        await ports.idempotency.release(recordId);
        return { outcome: "duplicate_trigger", existingId: existing.id };
      }

      let rule: BusinessRuleRecord;
      try {
        rule = await ports.businessRule.create({ businessId, kind: finalKind, trigger: finalTrigger, message: message.trim() });
      } catch (err) {
        await ports.idempotency.release(recordId);
        throw err;
      }

      await ports.idempotency.complete(null, recordId, 201, { rule: { id: rule.id, kind: rule.kind, trigger: rule.trigger } });

      try {
        await ports.notifyRuleEmployees?.(businessId, rule.id, `Nueva regla: ${message.trim()}`);
      } catch (notifyErr) {
        // notify failure is non-fatal — rule already persisted + idempotency sealed
        void notifyErr;
      }
      ports.invalidateSupervisorContext?.(businessId);

      try {
        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: rule.id,
          summary: `Creó regla de negocio: "${message.trim().slice(0, 60)}"`,
          payload: { ruleId: rule.id, kind: finalKind, trigger: finalTrigger },
        });
      } catch { /* audit gap — rule created, absorb audit failure */ }

      return { outcome: "created", rule };
    },
  };
}
