import type { BudgetRepositoryPort } from "@/domain/ports/budget.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface DeleteBudgetInput {
  businessId: string;
  actorUserId: string;
  budgetId: string;
  idempotencyKey: string;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type DeleteBudgetResult =
  | { outcome: "deleted" }
  | { outcome: "not_found" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  budget: BudgetRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}

export function deleteBudgetUseCase(ports: Ports) {
  return {
    async execute(input: DeleteBudgetInput): Promise<DeleteBudgetResult> {
      const { businessId, actorUserId, budgetId, idempotencyKey, actionMeta } = input;

      const budget = await ports.budget.findById(businessId, budgetId);
      if (!budget) return { outcome: "not_found" };

      const idempotency = await ports.idempotency.begin({
        businessId,
        actionType: actionMeta.actionType,
        idempotencyKey,
        requestBody: { budgetId: budget.id },
      });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        await ports.transaction.run(async (tx) => {
          await ports.budget.deleteInTransaction(tx, budget.id, businessId);
          await ports.idempotency.complete(tx, recordId, 204, null);
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: budget.id,
          summary: `Presupuesto eliminado: ${budget.id}`,
          payload: { budgetId: budget.id },
        });

        return { outcome: "deleted" };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
