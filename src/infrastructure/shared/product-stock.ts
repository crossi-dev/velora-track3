import type { Prisma } from "@prisma/client";

type TransactionClient = Prisma.TransactionClient;

export async function initInventory(
  tx: TransactionClient,
  args: {
    businessId: string;
    productId: string;
    productName: string;
    initialStock: number;
    stockReason: string;
    stockReferenceId: string | null;
  }
) {
  // Defense-in-depth tenant guard: scope write by businessId so a leaked
  // productId from another tenant cannot be used to overwrite their stock.
  await tx.product.update({
    where: { id: args.productId, businessId: args.businessId },
    data: { quantity: args.initialStock },
  });

  if (args.initialStock > 0) {
    await tx.stockMovement.create({
      data: {
        businessId: args.businessId,
        productId: args.productId,
        productName: args.productName,
        quantityBefore: 0,
        quantityAfter: args.initialStock,
        delta: args.initialStock,
        reason: args.stockReason,
        referenceId: args.stockReferenceId,
      },
    });
  }
}

export async function applyStockAdjustment(
  tx: TransactionClient,
  args: {
    businessId: string;
    productId: string;
    productName: string;
    stockQuantity: number;
    stockReason: string;
    stockReferenceId: string | null;
  }
) {
  // Tenant-scoped read: ensures we only read stock for a product that belongs
  // to this business. Missing businessId here would allow reading another
  // tenant's quantity and writing a false movement against this tenant.
  const current = await tx.product.findUnique({
    where: { id: args.productId, businessId: args.businessId },
    select: { quantity: true },
  });
  const qtyBefore = current?.quantity ?? 0;
  const qtyAfter = args.stockQuantity;

  // Defense-in-depth tenant guard: scope write by businessId to prevent
  // cross-tenant stock overwrite if productId leaked through upstream code.
  await tx.product.update({
    where: { id: args.productId, businessId: args.businessId },
    data: { quantity: qtyAfter },
  });

  if (qtyAfter !== qtyBefore) {
    await tx.stockMovement.create({
      data: {
        businessId: args.businessId,
        productId: args.productId,
        productName: args.productName,
        quantityBefore: qtyBefore,
        quantityAfter: qtyAfter,
        delta: qtyAfter - qtyBefore,
        reason: args.stockReason,
        referenceId: args.stockReferenceId,
      },
    });
  }
}
