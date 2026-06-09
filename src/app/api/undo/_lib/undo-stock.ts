import type { Prisma } from "@prisma/client";
import { completeIdempotentMutation } from "@/app/api/_lib/idempotency";

export async function undoStockBatchInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    movements: Array<{
      id: string;
      productId: string;
      productName: string;
      delta: number;
      referenceId: string | null;
    }>;
    idempotencyRecordId: string;
  }
) {
  const undoneLabels: string[] = [];

  for (const movement of args.movements) {
    const product = await tx.product.findUnique({
      where: { id: movement.productId, businessId: args.businessId },
      select: { quantity: true },
    });
    const currentQuantity = product?.quantity ?? 0;

    if (currentQuantity < movement.delta) {
      throw new Error(`STOCK_UNDO_CONFLICT:${movement.productName}`);
    }

    await tx.product.update({
      where: { id: movement.productId, businessId: args.businessId },
      data: { quantity: { decrement: movement.delta } },
    });

    if (movement.referenceId) {
      await tx.cashMovement.deleteMany({
        where: { id: movement.referenceId, businessId: args.businessId },
      });
    }

    // businessId guard — defense-in-depth against cross-tenant deletions even
    // though movement.id was pre-filtered by businessId in the caller's query.
    await tx.stockMovement.deleteMany({ where: { id: movement.id, businessId: args.businessId } });
    undoneLabels.push(`${movement.delta} × ${movement.productName}`);
  }

  const stockResponseBody = { deleted: args.movements.length, summary: undoneLabels };
  await completeIdempotentMutation({
    client: tx,
    recordId: args.idempotencyRecordId,
    responseStatus: 200,
    responseBody: stockResponseBody,
  });

  return undoneLabels;
}
