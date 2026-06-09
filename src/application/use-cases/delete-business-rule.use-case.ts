// Use-case: soft-delete (deactivate) a BusinessRule via the Supervisor (LLM-emitted action).
// "Delete" in the Supervisor context means flipping active=false, not removing the row.
// Owns the full idempotency lifecycle (begin / complete / release) so callers
// do NOT wrap this in withSupervisorContractGuards — that would double-begin.
// notifyRuleEmployees is intentionally NOT called — original exec body did not notify on delete.
//
// JD fixes (2026-05-30):
//   Bug3: uses deactivateAllActiveByTrigger which has an active:true filter → inactive rules
//         return count=0 → treated as not_found, matching old updateMany({active:true}) behavior.
//   Bug4: deactivateAllActiveByTrigger uses updateMany semantics to deactivate ALL active rows
//         matching the trigger (no unique constraint on trigger).
//   Bug5: assertDemoQuota injected via ports; quota checked after begin, releases on limit.

import type { BusinessRuleRepositoryPort } from "@/domain/ports/business-rule.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import { DemoLimitReachedError } from "@/app/api/_lib/demo-quota";

export interface DeleteBusinessRuleInput {
  businessId: string;
  actorUserId: string;
  ruleTrigger: string;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type DeleteBusinessRuleResult =
  | { outcome: "deleted"; count: number }
  | { outcome: "not_found"; ruleTrigger: string }
  | { outcome: "demo_limit_reached" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  businessRule: BusinessRuleRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  invalidateSupervisorContext: (businessId: string) => void;
  /** Optional: injected for demo-quota enforcement. No-op when omitted. */
  assertDemoQuota?: (businessId: string) => Promise<void>;
}

export function deleteBusinessRuleUseCase(ports: Ports) {
  return {
    async execute(input: DeleteBusinessRuleInput): Promise<DeleteBusinessRuleResult> {
      const { businessId, actorUserId, ruleTrigger, idempotencyKey, requestBody, actionMeta } = input;

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

      // Bug3 + Bug4: use deactivateAllActiveByTrigger which:
      //   - filters by active:true (inactive rules → count=0 → not_found, matching old behavior)
      //   - uses updateMany semantics (deactivates ALL matching active rows, not just one)
      let count: number;
      try {
        const result = await ports.businessRule.deactivateAllActiveByTrigger(businessId, ruleTrigger);
        count = result.count;
      } catch (err) {
        await ports.idempotency.release(recordId);
        throw err;
      }

      if (count === 0) {
        // No active rows found — treat as not_found (matches old updateMany count===0 path).
        await ports.idempotency.release(recordId);
        return { outcome: "not_found", ruleTrigger };
      }

      ports.invalidateSupervisorContext(businessId);

      await ports.idempotency.complete(null, recordId, 200, {
        ok: true,
        ruleTrigger,
        count,
      });

      try {
        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: null,
          summary: `Desactivó regla de negocio: "${ruleTrigger}"`,
          payload: { ruleTrigger, count },
        });
      } catch { /* audit gap — absorb */ }

      return { outcome: "deleted", count };
    },
  };
}
