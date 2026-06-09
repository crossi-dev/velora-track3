import type { ProductRepositoryPort, ProductRecord } from "@/domain/ports/product.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";

export interface CreateProductInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  name: string;
  price: number;
  costPrice: number | null;
  /** Weight in grams. Null when not provided — Logística falls back to 500 g/item. */
  weightGrams?: number | null;
  initialStock: number;
  stockReason: string;
  stockReferenceId: string | null;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type CreateProductResult =
  | { outcome: "created"; product: ProductRecord }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  product: ProductRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
}

export function createProductUseCase(ports: Ports) {
  return {
    async execute(input: CreateProductInput): Promise<CreateProductResult> {
      const { businessId, actorUserId, actorEmployeeId, name, price, costPrice, weightGrams, initialStock, stockReason, stockReferenceId, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const product = await ports.product.createWithSkuRetry(
          { businessId, name, price, costPrice, weightGrams: weightGrams ?? null, initialStock, stockReason, stockReferenceId },
          async (tx, created) => {
            await ports.idempotency.complete(tx, recordId, 201, {
              product: { id: created.id, name: created.name, price: created.price, costPrice: created.costPrice, sku: created.sku, stock: initialStock },
            });
          }
        );

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: product.id,
          summary: `Producto creado: ${product.name}`,
          payload: { id: product.id, name: product.name, price: product.price, costPrice: product.costPrice, sku: product.sku, stock: initialStock },
        });

        return { outcome: "created", product };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
