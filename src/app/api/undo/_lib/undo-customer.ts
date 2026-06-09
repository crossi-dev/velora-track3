import type { Prisma } from "@prisma/client";
import { completeIdempotentMutation } from "@/app/api/_lib/idempotency";

export async function undoCustomerBatchInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    customerIds: string[];
    customers: Array<{ id: string; name: string }>;
    idempotencyRecordId: string;
  }
) {
  // businessId guard — defense-in-depth against cross-tenant deletions even
  // though customerIds were pre-filtered by businessId in the caller's query.
  await tx.customer.deleteMany({ where: { id: { in: args.customerIds }, businessId: args.businessId } });

  const customerResponseBody = {
    deleted: args.customers.length,
    summary: args.customers.map((customer) => customer.name),
  };

  await completeIdempotentMutation({
    client: tx,
    recordId: args.idempotencyRecordId,
    responseStatus: 200,
    responseBody: customerResponseBody,
  });

  return customerResponseBody;
}
