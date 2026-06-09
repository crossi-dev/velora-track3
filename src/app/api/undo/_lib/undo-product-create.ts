import type { Prisma } from "@prisma/client";
import { completeIdempotentMutation } from "@/app/api/_lib/idempotency";

/**
 * Sentinel error thrown when a concurrent sale registered a SaleItem
 * referencing the product between the upstream pre-check and this
 * transaction. The route catch translates it to a 409.
 */
export const PRODUCT_HAS_SALE_ITEMS_ERROR = "PRODUCT_HAS_SALE_ITEMS";

/**
 * Deletes a recently created product. Caller MUST verify upstream that:
 *   1. The product belongs to the business (tenant isolation)
 *   2. The product has no SaleItem rows (otherwise sales reference it)
 *
 * Even with the upstream pre-check, we re-verify the SaleItem count
 * INSIDE the transaction to close the race window. The transaction also
 * deletes the auto-created Inventory row and any stockMovement rows so
 * the FK chain unwinds cleanly.
 */
export async function undoProductCreateInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    productId: string;
    productName: string;
    idempotencyRecordId: string;
  }
) {
  // Race-safe re-check: a concurrent sale may have inserted a SaleItem
  // pointing at this product after the upstream pre-check. If so, refuse
  // the undo — the FK constraint would otherwise raise a generic 500.
  const saleItemCount = await tx.saleItem.count({
    where: { productId: args.productId },
  });
  if (saleItemCount > 0) {
    throw new Error(PRODUCT_HAS_SALE_ITEMS_ERROR);
  }

  // Order matters: delete child rows before the parent product.
  await tx.stockMovement.deleteMany({
    where: { productId: args.productId, businessId: args.businessId },
  });
  await tx.product.deleteMany({
    where: { id: args.productId, businessId: args.businessId },
  });

  const responseBody = {
    deleted: 1,
    summary: [args.productName],
  };

  await completeIdempotentMutation({
    client: tx,
    recordId: args.idempotencyRecordId,
    responseStatus: 200,
    responseBody,
  });

  return responseBody;
}
