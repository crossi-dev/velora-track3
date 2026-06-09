import type { CustomerRepositoryPort, CustomerRecord } from "@/domain/ports/customer.repository.port";
import type { IdempotencyPort } from "@/domain/ports/idempotency.port";
import type { AuditPort } from "@/domain/ports/audit.port";
import type { TransactionPort } from "@/domain/ports/transaction.port";

export interface CreateCustomerInput {
  businessId: string;
  actorUserId: string;
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

export type CreateCustomerResult =
  | { outcome: "created"; customer: CustomerRecord }
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

export function createCustomerUseCase(ports: Ports) {
  return {
    async execute(input: CreateCustomerInput): Promise<CreateCustomerResult> {
      const { businessId, actorUserId, name, phone, email, taxId, dni, ivaCondition, address, postalCode, city, idempotencyKey, requestBody, actionMeta } = input;

      const idempotency = await ports.idempotency.begin({ businessId, actionType: actionMeta.actionType, idempotencyKey, requestBody });

      if (idempotency.kind === "replay") return { outcome: "replayed", status: idempotency.status, body: idempotency.body };
      if (idempotency.kind === "missing") return { outcome: "idempotency_missing" };
      if (idempotency.kind === "conflict") return { outcome: "idempotency_conflict" };
      if (idempotency.kind === "in_flight") return { outcome: "idempotency_in_flight" };

      const { recordId } = idempotency;

      try {
        const customer = await ports.transaction.run(async (tx) => {
          const created = await ports.customer.createInTransaction(tx, { businessId, name, phone, email, taxId, dni, ivaCondition, address, postalCode, city });
          await ports.idempotency.complete(tx, recordId, 201, { customer: created });
          return created;
        });

        await ports.audit.recordCriticalWrite({
          businessId,
          actorUserId,
          actorEmployeeId: null,
          routeScope: actionMeta.routeScope,
          actionType: actionMeta.actionType,
          resourceType: actionMeta.resourceType,
          resourceId: customer.id,
          summary: `Cliente creado: ${customer.name}`,
          payload: { customerId: customer.id, customerName: customer.name, phone: customer.phone, email: customer.email, taxId: customer.taxId },
        });

        return { outcome: "created", customer };
      } catch (error) {
        await ports.idempotency.release(recordId);
        throw error;
      }
    },
  };
}
