import type { SupplierRepositoryPort } from "@/domain/ports/supplier.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface DeleteSupplierInput {
  businessId: string;
  actorUserId: string;
  supplierId: string;
  idempotencyKey: string;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type DeleteSupplierResult =
  | { outcome: "deleted" }
  | { outcome: "not_found" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  supplier: SupplierRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}

export function deleteSupplierUseCase(ports: Ports) {
  return {
    async execute(input: DeleteSupplierInput): Promise<DeleteSupplierResult> {
      const { businessId, actorUserId, supplierId, idempotencyKey, actionMeta } = input;

      const supplier = await ports.supplier.findById(businessId, supplierId);
      if (!supplier) return { outcome: "not_found" };

      const idempotency = await ports.idempotency.begin({
        businessId,
        actionType: actionMeta.actionType,
        idempotencyKey,
        requestBody: { id: supplier.id },
      });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        await ports.transaction.run(async (tx) => {
          await ports.supplier.deleteInTransaction(tx, {
            businessId,
            supplierId: supplier.id,
            snapshot: { name: supplier.name, phone: supplier.phone, email: supplier.email, contactName: supplier.contactName },
          });
          await ports.idempotency.complete(tx, recordId, 200, { ok: true });
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: supplier.id,
          summary: `Proveedor eliminado: ${supplier.name}`,
          payload: { supplierId: supplier.id, supplierName: supplier.name, phone: supplier.phone, email: supplier.email, contactName: supplier.contactName },
        });

        return { outcome: "deleted" };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
