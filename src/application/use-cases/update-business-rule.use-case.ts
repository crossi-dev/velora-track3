// Use-case: update an existing BusinessRule via the Supervisor (LLM-emitted action).
// Owns the full idempotency lifecycle (begin / complete / release) so callers
// do NOT wrap this in withSupervisorContractGuards — that would double-begin.
// notifyRuleEmployees is preserved as a side-effect after a successful update.
//
// JD fixes (2026-05-30):
//   Bug1: cron validation uses existing.kind (from findByTrigger) not a hardcoded default.
//   Bug2: notifyRuleEmployees is wrapped in try/catch; throws release idempotency first.
//   Bug5: assertDemoQuota injected via ports; quota checked after begin, releases on limit.

import type { BusinessRuleRepositoryPort, BusinessRuleRecord } from "@/domain/ports/business-rule.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import { DemoLimitReachedError } from "@/app/api/_lib/demo-quota";
import { isValidCronExpression } from "@/domain/rules/cron-validation";

export interface UpdateBusinessRuleInput {
  businessId: string;
  actorUserId: string;
  ruleTrigger: string;
  updates: { kind?: string; trigger?: string; message?: string; active?: boolean };
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type UpdateBusinessRuleResult =
  | { outcome: "updated"; rule: BusinessRuleRecord }
  | { outcome: "not_found"; ruleTrigger: string }
  | { outcome: "cron_invalid" }
  | { outcome: "demo_limit_reached" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  businessRule: BusinessRuleRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  notifyRuleEmployees: (businessId: string, ruleId: string, body: string) => Promise<void>;
  invalidateSupervisorContext: (businessId: string) => void;
  /** Optional: injected for demo-quota enforcement. No-op when omitted. */
  assertDemoQuota?: (businessId: string) => Promise<void>;
}

export function updateBusinessRuleUseCase(ports: Ports) {
  return {
    async execute(input: UpdateBusinessRuleInput): Promise<UpdateBusinessRuleResult> {
      const { businessId, actorUserId, ruleTrigger, updates, idempotencyKey, requestBody, actionMeta } = input;

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

      // Bug5: assertDemoQuota after begin so replays of already-counted actions are never blocked.
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

      // findByTrigger now returns { id, kind } so we can validate cron using the STORED kind.
      const existing = await ports.businessRule.findByTrigger(businessId, ruleTrigger);
      if (!existing) {
        await ports.idempotency.release(recordId);
        return { outcome: "not_found", ruleTrigger };
      }

      // Bug1: effectiveKind uses the rule's STORED kind, not a hardcoded fallback.
      // When the caller doesn't send a new kind, we use the existing one for cron validation.
      if (updates.trigger !== undefined) {
        const effectiveKind = (updates.kind ?? existing.kind) as string;
        if (effectiveKind === "time-based" && !isValidCronExpression(updates.trigger)) {
          await ports.idempotency.release(recordId);
          return { outcome: "cron_invalid" };
        }
      }

      let rule: BusinessRuleRecord | null;
      try {
        rule = await ports.businessRule.update(businessId, existing.id, updates);
      } catch (err) {
        await ports.idempotency.release(recordId);
        throw err;
      }

      if (!rule) {
        // update returned null — row disappeared between findByTrigger and update
        await ports.idempotency.release(recordId);
        return { outcome: "not_found", ruleTrigger };
      }

      // Side-effect: notify all active employees of the rule change.
      // Bug2: wrap in try/catch — notify failure releases idempotency before rethrowing.
      const notifyMsg = updates.message ?? rule.message;
      try {
        await ports.notifyRuleEmployees(businessId, existing.id, `Regla actualizada: ${notifyMsg}`);
      } catch (notifyErr) {
        await ports.idempotency.release(recordId);
        throw notifyErr;
      }

      ports.invalidateSupervisorContext(businessId);

      await ports.idempotency.complete(null, recordId, 200, {
        ok: true,
        ruleId: existing.id,
        ruleTrigger,
      });

      try {
        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: existing.id,
          summary: `Actualizó regla de negocio: "${ruleTrigger}"`,
          payload: { ruleId: existing.id, ruleTrigger, updates },
        });
      } catch { /* audit gap — absorb */ }

      return { outcome: "updated", rule };
    },
  };
}
