import type { ProductRepositoryPort, ProductForDelete } from "@/domain/ports/product.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface DeleteProductInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  productId: string;
  idempotencyKey: string;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type DeleteProductResult =
  | { outcome: "deleted"; archived: boolean }
  | { outcome: "not_found" }
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

export function deleteProductUseCase(ports: Ports) {
  return {
    async execute(input: DeleteProductInput): Promise<DeleteProductResult> {
      const { businessId, actorUserId, actorEmployeeId, productId, idempotencyKey, actionMeta } = input;

      const product: ProductForDelete | null = await ports.product.findForDelete(businessId, productId);
      if (!product) return { outcome: "not_found" };

      const idempotency = await ports.idempotency.begin({
        businessId,
        actionType: actionMeta.actionType,
        idempotencyKey,
        requestBody: { id: product.id },
      });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const { archived } = await ports.transaction.run(async (tx) => {
          const result = await ports.product.deleteInTransaction(tx, { businessId, productId: product.id });
          await ports.idempotency.complete(tx, recordId, 200, { ok: true, archived: result.archived });
          return result;
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: product.id,
          summary: archived ? `Producto archivado (con ventas asociadas): ${product.name}` : `Producto eliminado: ${product.name}`,
          payload: {
            productId: product.id,
            name: product.name,
            price: product.price,
            stock: product.stock,
            sku: product.sku,
            costPrice: product.costPrice,
            deleteMode: archived ? "soft_archived" : "hard_deleted",
            saleItemsCount: product.saleItemsCount,
            stockMovementsCount: product.stockMovementsCount,
          },
        });

        return { outcome: "deleted", archived };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}

export type { ProductForDelete };
