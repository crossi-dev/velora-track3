import type { Prisma } from "@prisma/client";
import { completeIdempotentMutation } from "@/app/api/_lib/idempotency";

export type RestoredProductData = {
  name: string;
  price?: number;
  stock?: number;
  sku?: string | null;
  costPrice?: number | null;
};

export function parseRestoredProductData(raw: unknown): RestoredProductData | null {
  if (!raw || typeof raw !== "object") return null;

  const data = raw as Record<string, unknown>;
  if (typeof data.name !== "string" || !data.name.trim()) return null;

  const price = typeof data.price === "number" && Number.isFinite(data.price) && data.price >= 0
    ? data.price
    : null;
  if (price === null) return null;

  const parsed: RestoredProductData = {
    name: data.name.trim(),
    price,
  };

  if (typeof data.stock === "number" && Number.isFinite(data.stock) && data.stock >= 0) {
    parsed.stock = data.stock;
  }

  if (data.sku === null || typeof data.sku === "string") {
    parsed.sku = data.sku ?? null;
  }

  if (data.costPrice === null || (typeof data.costPrice === "number" && Number.isFinite(data.costPrice) && data.costPrice >= 0)) {
    parsed.costPrice = data.costPrice ?? null;
  }

  return parsed;
}

export async function restoreDeletedProductInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    productId: string;
    productData: RestoredProductData;
  }
) {
  await tx.product.create({
    data: {
      id: args.productId,
      businessId: args.businessId,
      name: args.productData.name,
      price: args.productData.price ?? 0,
      sku: args.productData.sku ?? null,
      costPrice: args.productData.costPrice ?? null,
      quantity: args.productData.stock ?? 0,
    },
  });
}

export async function undoProductRestoreInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    productId: string;
    productData: RestoredProductData;
    idempotencyRecordId: string;
  }
) {
  await restoreDeletedProductInTransaction(tx, {
    businessId: args.businessId,
    productId: args.productId,
    productData: args.productData,
  });

  const productResponseBody = { restored: 1, productId: args.productId, name: args.productData.name };
  await completeIdempotentMutation({
    client: tx,
    recordId: args.idempotencyRecordId,
    responseStatus: 200,
    responseBody: productResponseBody,
  });

  return productResponseBody;
}
