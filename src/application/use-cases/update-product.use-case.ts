import type { ProductRepositoryPort } from "@/domain/ports/product.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface UpdateProductInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  productId: string;
  name?: string;
  price?: number;
  costPrice?: number | null;
  sku?: string | null;
  /** Weight in grams. Null explicitly clears. Undefined = no change. */
  weightGrams?: number | null;
  stockQuantity?: number;
  stockReason: string;
  stockReferenceId: string | null;
  productUpdateData: { name?: string; price?: number; costPrice?: number | null; sku?: string | null; weightGrams?: number | null };
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type UpdateProductResult =
  | { outcome: "updated"; productId: string; productName: string; updatedSku?: string | null }
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

export function updateProductUseCase(ports: Ports) {
  return {
    async execute(input: UpdateProductInput): Promise<UpdateProductResult> {
      const { businessId, actorUserId, actorEmployeeId, productId, name, price, costPrice, sku, weightGrams, stockQuantity, stockReason, stockReferenceId, productUpdateData, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const result = await ports.transaction.run(async (tx) => {
          const updated = await ports.product.updateInTransaction(tx, { businessId, productId, name, price, costPrice, sku, weightGrams, stockQuantity, stockReason, stockReferenceId });
          await ports.idempotency.complete(tx, recordId, 200, { ok: true });
          return updated;
        });

        const changedSku = sku !== undefined ? result.updatedSku : undefined;
        const auditPayload = { ...productUpdateData, ...(changedSku !== undefined ? { sku: changedSku } : {}), ...(stockQuantity !== undefined ? { stock: stockQuantity } : {}), stockReason: stockReason || null, stockReferenceId: stockReferenceId || null };

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: result.productId,
          summary: `Producto actualizado: ${result.productName}`,
          payload: { productId: result.productId, changes: auditPayload },
        });

        return { outcome: "updated", productId: result.productId, productName: result.productName, updatedSku: result.updatedSku };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
