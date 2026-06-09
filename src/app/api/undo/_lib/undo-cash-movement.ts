import type { Prisma } from "@prisma/client";
import { completeIdempotentMutation } from "@/app/api/_lib/idempotency";

/**
 * Deletes the most recently created MANUAL cash movement(s) for a business.
 * The deleteMany guard `saleId: null` is critical — sale-linked movements
 * must only be reversed via undo target=sale, never directly, otherwise
 * the cash ledger and the sale record would diverge.
 */
export async function undoCashMovementBatchInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    movementIds: string[];
    movements: Array<{ id: string; description: string; amount: number }>;
    idempotencyRecordId: string;
  }
) {
  await tx.cashMovement.deleteMany({
    where: {
      id: { in: args.movementIds },
      businessId: args.businessId,
      saleId: null,
    },
  });

  const responseBody = {
    deleted: args.movements.length,
    summary: args.movements.map((movement) => movement.description),
  };

  await completeIdempotentMutation({
    client: tx,
    recordId: args.idempotencyRecordId,
    responseStatus: 200,
    responseBody,
  });

  return responseBody;
}
