import type { ProductRepositoryPort, ResolvedProductRecord } from "@/domain/ports/product.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";

export interface ResolveOrCreateProductInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  productName: string;
  normalizedName: string;
  price: number;
  costPrice?: number | null;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type ResolveOrCreateProductResult =
  | { outcome: "resolved" | "created"; product: ResolvedProductRecord }
  | { outcome: "sku_collision" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" | "idempotency_conflict" | "idempotency_in_flight" };

interface Ports {
  product: ProductRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
}

export function resolveOrCreateProductUseCase(ports: Ports) {
  return {
    async execute(input: ResolveOrCreateProductInput): Promise<ResolveOrCreateProductResult> {
      const { businessId, actorUserId, actorEmployeeId, productName, normalizedName, price, costPrice, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const result = await ports.product.resolveOrCreateWithSkuRetry(
          businessId,
          { name: productName, price, costPrice },
          normalizedName,
          async (tx, p) => {
            await ports.idempotency.complete(tx, recordId, 201, {
              resolved: false,
              product: { id: p.id, name: p.name, price: p.price, costPrice: p.costPrice, sku: p.sku },
            });
          }
        );

        if (result.outcome === "sku_collision") {
          await ports.idempotency.release(recordId);
          return { outcome: "sku_collision" };
        }

        if (result.outcome === "resolved") {
          // null tx: product already existed, no transaction was opened — complete outside any tx
          await ports.idempotency.complete(null, recordId, 200, {
            resolved: true,
            product: { id: result.product.id, name: result.product.name, price: result.product.price, costPrice: result.product.costPrice, sku: result.product.sku },
          });
          return { outcome: "resolved", product: result.product };
        }

        await ports.audit.recordCriticalWrite({
          businessId, actorUserId, actorEmployeeId,
          routeScope: actionMeta.routeScope, actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType, resourceId: result.product.id,
          summary: `Producto resuelto-o-creado: ${result.product.name}`,
          payload: { productId: result.product.id, name: result.product.name, price: result.product.price, costPrice: result.product.costPrice, sku: result.product.sku, source: "resolve-or-create" },
        });

        return { outcome: "created", product: result.product };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
