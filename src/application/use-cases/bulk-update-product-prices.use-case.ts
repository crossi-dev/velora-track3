import type { ProductRepositoryPort } from "@/domain/ports/product.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import { roundMoney } from "@/lib/money";

type BulkPriceMode = "percentage" | "absolute";
type BulkPriceDirection = "up" | "down" | "set";

function calculateUpdatedPrice(oldPrice: number, amount: number, mode: BulkPriceMode, direction: BulkPriceDirection): number {
  let next: number;
  if (direction === "set") {
    next = roundMoney(amount).toNumber();
  } else if (mode === "percentage") {
    const factor = direction === "up" ? 1 + amount / 100 : 1 - amount / 100;
    next = roundMoney(oldPrice * factor).toNumber();
  } else {
    const raw = direction === "up" ? oldPrice + amount : oldPrice - amount;
    next = roundMoney(raw).toNumber();
  }
  // Floor at 0.01 — a bulk price change must NEVER produce a free (0) product. A deep
  // percentage discount can round a low price to 0, and a large fixed-down can drive it
  // negative; both would create a zero-price product that sells for nothing. Floor it.
  return Math.max(0.01, next);
}

export interface BulkUpdateProductPricesInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  amount: number;
  mode: BulkPriceMode;
  direction: BulkPriceDirection;
  productIds: string[];
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type BulkUpdateProductPricesResult =
  | { outcome: "updated"; count: number; summary: string }
  | { outcome: "no_products" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  product: ProductRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}

export function bulkUpdateProductPricesUseCase(ports: Ports) {
  return {
    async execute(input: BulkUpdateProductPricesInput): Promise<BulkUpdateProductPricesResult> {
      const { businessId, actorUserId, actorEmployeeId, amount, mode, direction, productIds, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      const products = await ports.product.fetchForBulkPriceUpdate(businessId, productIds);

      if (products.length === 0) {
        await ports.idempotency.release(recordId);
        return { outcome: "no_products" };
      }

      const updates = products.map((p) => ({
        id: p.id,
        name: p.name,
        oldPrice: p.price,
        newPrice: calculateUpdatedPrice(p.price, amount, mode, direction),
      }));

      try {
        await ports.transaction.run(async (tx) => {
          await ports.product.bulkUpdatePricesInTransaction(tx, businessId, updates.map((u) => ({ id: u.id, newPrice: u.newPrice })));
          await ports.idempotency.complete(tx, recordId, 200, { updated: updates.length });
        });

        const dirLabel = direction === "up" ? "aumentados" : direction === "down" ? "reducidos" : "actualizados";
        const amountLabel = mode === "percentage" ? `${amount}%` : `$${amount}`;
        const summary = `${updates.length} precios ${dirLabel} ${amountLabel}.`;

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          summary,
          payload: {
            amount,
            mode,
            direction,
            productCount: updates.length,
            products: updates.map((u) => ({ id: u.id, name: u.name, oldPrice: u.oldPrice, newPrice: u.newPrice })),
          },
        });

        return { outcome: "updated", count: updates.length, summary };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
