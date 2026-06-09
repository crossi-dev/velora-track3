import type { InvoiceRepositoryPort, InvoiceStatusRecord } from "@/domain/ports/invoice.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface UpdateInvoiceStatusInput {
  businessId: string;
  actorUserId: string;
  actorEmployeeId: string | null;
  invoiceId: string;
  newStatus: string;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type UpdateInvoiceStatusResult =
  | { outcome: "updated"; invoice: InvoiceStatusRecord }
  | { outcome: "not_found" }
  | { outcome: "paid_downgrade" }
  | { outcome: "sent_to_issued" }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  invoice: InvoiceRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}

export function updateInvoiceStatusUseCase(ports: Ports) {
  return {
    async execute(input: UpdateInvoiceStatusInput): Promise<UpdateInvoiceStatusResult> {
      const { businessId, actorUserId, actorEmployeeId, invoiceId, newStatus, idempotencyKey, requestBody, actionMeta } = input;

      const invoice = await ports.invoice.findForStatusUpdate(businessId, invoiceId);
      if (!invoice) return { outcome: "not_found" };

      const current = invoice.status;
      if (current === "paid" && (newStatus === "issued" || newStatus === "sent")) return { outcome: "paid_downgrade" };
      if (current === "sent" && newStatus === "issued") return { outcome: "sent_to_issued" };

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const updated = await ports.transaction.run(async (tx) => {
          const inv = await ports.invoice.updateStatusInTransaction(tx, { invoiceId, businessId, status: newStatus });
          await ports.idempotency.complete(tx, recordId, 200, { invoice: inv });
          return inv;
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: updated.id,
          summary: `Factura ${updated.invoiceNumber} marcada como ${updated.status === "sent" ? "enviada" : updated.status === "paid" ? "cobrada" : updated.status}`,
          payload: { invoiceId: updated.id, status: updated.status },
        });

        return { outcome: "updated", invoice: updated };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
