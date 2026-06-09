import type { CustomerRepositoryPort } from "@/domain/ports/customer.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface DeleteCustomerInput {
  businessId: string;
  actorUserId: string;
  customerId: string;
  idempotencyKey: string;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type DeleteCustomerResult =
  | { outcome: "deleted" }
  | { outcome: "not_found" }
  | { outcome: "has_history"; invoiceCount: number; saleCount: number }
  | { outcome: "replayed"; status: number; body: unknown }
  | { outcome: "idempotency_missing" }
  | { outcome: "idempotency_conflict" }
  | { outcome: "idempotency_in_flight" };

interface Ports {
  customer: CustomerRepositoryPort;
  idempotency: IdempotencyPort;
  audit: AuditPort;
  transaction: TransactionPort;
}

export function deleteCustomerUseCase(ports: Ports) {
  return {
    async execute(input: DeleteCustomerInput): Promise<DeleteCustomerResult> {
      const { businessId, actorUserId, customerId, idempotencyKey, actionMeta } = input;

      const customer = await ports.customer.findById(businessId, customerId);
      if (!customer) return { outcome: "not_found" };

      // Guard: block delete if the customer has associated history records.
      // FK constraints aside, deleting a customer with invoices/sales would
      // lose auditable financial history. Return has_history so the caller
      // can offer anonymisation instead.
      const { invoiceCount, saleCount } = await ports.customer.hasHistory(businessId, customerId);
      if (invoiceCount > 0 || saleCount > 0) {
        return { outcome: "has_history", invoiceCount, saleCount };
      }

      const idempotency = await ports.idempotency.begin({
        businessId,
        actionType: actionMeta.actionType,
        idempotencyKey,
        requestBody: { id: customer.id },
      });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        await ports.transaction.run(async (tx) => {
          await ports.customer.deleteInTransaction(tx, {
            businessId,
            customerId: customer.id,
            snapshot: { name: customer.name, phone: customer.phone, email: customer.email, taxId: customer.taxId },
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
          resourceId: customer.id,
          summary: `Cliente eliminado: ${customer.name}`,
          payload: { customerId: customer.id, customerName: customer.name, phone: customer.phone, email: customer.email, taxId: customer.taxId },
        });

        return { outcome: "deleted" };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
