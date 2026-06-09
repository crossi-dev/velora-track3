import type { PurchaseRequestRepositoryPort, PurchaseRequestRecord } from "@/domain/ports/purchase-request.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface CreatePurchaseRequestInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  itemName: string;
  quantity: number;
  unitPrice: number;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type CreatePurchaseRequestResult =
  | { outcome: "created"; request: PurchaseRequestRecord }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  purchaseRequest: PurchaseRequestRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}

export function createPurchaseRequestUseCase(ports: Ports) {
  return {
    async execute(input: CreatePurchaseRequestInput): Promise<CreatePurchaseRequestResult> {
      const { businessId, actorUserId, actorEmployeeId, supplierId, supplierName, itemName, quantity, unitPrice, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const result = await ports.transaction.run(async (tx) => {
          const created = await ports.purchaseRequest.createInTransaction(tx, { businessId, supplierId, supplierName, itemName, quantity, unitPrice });
          await ports.idempotency.complete(tx, recordId, 201, { request: created.request });
          return created;
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: result.auditMeta.requestId,
          summary: `Solicitud de compra creada — ${result.auditMeta.requestNumber} — ${result.auditMeta.supplierName}`,
          payload: {
            requestId: result.auditMeta.requestId,
            requestNumber: result.auditMeta.requestNumber,
            supplierId: result.auditMeta.supplierId,
            supplierName: result.auditMeta.supplierName,
            itemName: result.auditMeta.itemName,
            quantity: result.auditMeta.quantity,
            unitPrice: result.auditMeta.unitPrice,
            totalAmount: result.auditMeta.totalAmount,
          },
        });

        return { outcome: "created", request: result.request };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
