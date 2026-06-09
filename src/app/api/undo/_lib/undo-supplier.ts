import type { Prisma } from "@prisma/client";
import { completeIdempotentMutation } from "@/app/api/_lib/idempotency";

/**
 * Deletes the most recently created supplier(s) for a business.
 * Caller must have already verified ownership and obtained the supplier
 * IDs from the CriticalWriteEvent audit log within the undo cutoff window.
 *
 * Supplier has no FK constraints to sales/movements, so deletion is safe
 * — but we still scope by businessId at the query level as defense in depth.
 */
export async function undoSupplierBatchInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    supplierIds: string[];
    suppliers: Array<{ id: string; name: string }>;
    idempotencyRecordId: string;
  }
) {
  await tx.supplier.deleteMany({
    where: { id: { in: args.supplierIds }, businessId: args.businessId },
  });

  const responseBody = {
    deleted: args.suppliers.length,
    summary: args.suppliers.map((supplier) => supplier.name),
  };

  await completeIdempotentMutation({
    client: tx,
    recordId: args.idempotencyRecordId,
    responseStatus: 200,
    responseBody,
  });

  return responseBody;
}
