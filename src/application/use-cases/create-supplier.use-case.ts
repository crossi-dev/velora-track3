import type { SupplierRepositoryPort, SupplierRecord } from "@/domain/ports/supplier.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

function toSupplierResponseShape(s: SupplierRecord) {
  return { id: s.id, name: s.name, phone: s.phone, contactName: s.contactName, taxId: null, email: s.email, leadTimeDays: s.leadTimeDays ?? 3 };
}

export interface CreateSupplierInput {
  businessId: string;
  actorUserId: string;
  name: string;
  phone?: string | null;
  email?: string | null;
  contactName?: string | null;
  leadTimeDays?: number | null;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type CreateSupplierResult =
  | { outcome: "created"; supplier: SupplierRecord }
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

export function createSupplierUseCase(ports: Ports) {
  return {
    async execute(input: CreateSupplierInput): Promise<CreateSupplierResult> {
      const { businessId, actorUserId, name, phone, email, contactName, leadTimeDays, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const supplier = await ports.transaction.run(async (tx) => {
          const created = await ports.supplier.createInTransaction(tx, { businessId, name, phone, email, contactName, leadTimeDays });
          await ports.idempotency.complete(tx, recordId, 201, { supplier: toSupplierResponseShape(created) });
          return created;
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: supplier.id,
          summary: `Proveedor creado: ${supplier.name}`,
          payload: { supplierId: supplier.id, supplierName: supplier.name, phone: supplier.phone, email: supplier.email, contactName: supplier.contactName },
        });

        return { outcome: "created", supplier };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
