import type { SupplierRepositoryPort } from "@/domain/ports/supplier.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface UpdateSupplierInput {
  businessId: string;
  actorUserId: string;
  supplierId: string;
  name?: string;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  leadTimeDays?: number | null;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type UpdateSupplierResult =
  | { outcome: "updated" }
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

export function updateSupplierUseCase(ports: Ports) {
  return {
    async execute(input: UpdateSupplierInput): Promise<UpdateSupplierResult> {
      const { businessId, actorUserId, supplierId, name, phone, email, contactName, leadTimeDays, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        await ports.transaction.run(async (tx) => {
          await ports.supplier.updateInTransaction(tx, { businessId, supplierId, name, phone, email, contactName, leadTimeDays });
          await ports.idempotency.complete(tx, recordId, 200, { ok: true });
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: supplierId,
          summary: "Proveedor actualizado",
          payload: { supplierId, changes: { name, phone, email, contactName, leadTimeDays } },
        });

        return { outcome: "updated" };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
