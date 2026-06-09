import type { BudgetRepositoryPort, BudgetRecord, BudgetItemRecord } from "@/domain/ports/budget.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import { sumLineItems } from "@/lib/money";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface CreateBudgetInput {
  businessId: string;
  actorUserId: string;
  currency: string;
  customerName: string | null;
  customerId: string | null;
  note: string | null;
  totalAmount: number;
  items: Array<{ productId: string | null; name: string; quantity: number; unitPrice: number }>;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type CreateBudgetResult =
  | { outcome: "created"; budget: BudgetRecord }
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

export function createBudgetUseCase(ports: Ports) {
  return {
    async execute(input: CreateBudgetInput): Promise<CreateBudgetResult> {
      // totalAmount from input is intentionally ignored — serverTotal is computed from items below
      const { businessId, actorUserId, currency, customerName, customerId, note, items, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const budget = await ports.transaction.run(async (tx) => {
          // Server-compute the total from line items to reject tampered client totals.
          // sumLineItems uses Prisma.Decimal (decimal.js) → exact ROUND_HALF_UP.
          // Source: https://mikemcl.github.io/decimal.js/ (VERIFIED HTTP 200)
          const serverTotal = sumLineItems(items).toNumber();
          const created = await ports.budget.createInTransaction(tx, { businessId, currency, customerName, customerId, note, totalAmount: serverTotal, items });
          await ports.idempotency.complete(tx, recordId, 201, { budget: created });
          return created;
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: budget.id,
          summary: `Presupuesto creado: ${budget.budgetNumber}`,
          payload: { budgetId: budget.id, budgetNumber: budget.budgetNumber, customerName: budget.customerName, totalAmount: budget.totalAmount, itemCount: budget.items.length },
        });

        return { outcome: "created", budget };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}

export type { BudgetRecord, BudgetItemRecord };
