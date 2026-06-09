import type { CustomerRepositoryPort, CustomerRecord } from "@/domain/ports/customer.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";
import { normalizeCustomerNullableText } from "@/lib/normalize";

export interface UpdateCustomerInput {
  businessId: string;
  actorUserId: string;
  customerId: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
  dni?: string | null;
  ivaCondition?: string | null;
  address?: string | null;
  postalCode?: string | null;
  city?: string | null;
  idempotencyKey: string;
  requestBody: unknown;
  actionMeta: { actionType: string; routeScope: string; resourceType: string };
}

export type UpdateCustomerResult =
  | { outcome: "updated"; customer: CustomerRecord }
  | { outcome: "not_found" }
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

export function updateCustomerUseCase(ports: Ports) {
  return {
    async execute(input: UpdateCustomerInput): Promise<UpdateCustomerResult> {
      const { businessId, actorUserId, customerId, name, phone, email, taxId, dni, ivaCondition, address, postalCode, city, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const customer = await ports.transaction.run(async (tx) => {
          const updated = await ports.customer.updateInTransaction(tx, { businessId, customerId, name, phone, email, taxId, dni, ivaCondition, address, postalCode, city });
          await ports.idempotency.complete(tx, recordId, 200, { ok: true });
          return updated;
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: customerId,
          summary: "Cliente actualizado",
          payload: {
            customerId,
            changes: {
              name,
              phone: normalizeCustomerNullableText(phone),
              email: normalizeCustomerNullableText(email),
              taxId: normalizeCustomerNullableText(taxId),
              ivaCondition: normalizeCustomerNullableText(ivaCondition),
            },
          },
        });

        return { outcome: "updated", customer };
      } catch (error) {
        await ports.idempotency.release(recordId);
        if (error instanceof Error && error.message === "CUSTOMER_NOT_FOUND") {
          return { outcome: "not_found" };
        }
        throw error;
      }
    },
  };
}
