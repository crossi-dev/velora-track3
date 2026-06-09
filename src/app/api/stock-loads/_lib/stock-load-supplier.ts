import type { Prisma } from "@prisma/client";
import { resolveOrCreateSupplierInTransaction } from "@/app/api/_lib/supplier-resolution";

export type StockLoadSupplier = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  contactName: string | null;
};

/**
 * Resolve or create a supplier INSIDE the stock-load transaction.
 * Composite child of stock-load.create (supplier.resolve-or-create).
 */
export async function resolveStockLoadSupplier(
  tx: Prisma.TransactionClient,
  params: {
    businessId: string;
    supplierId: string;
    supplierName: string;
  },
): Promise<StockLoadSupplier | null> {
  return resolveOrCreateSupplierInTransaction(tx, {
    businessId: params.businessId,
    supplierId: params.supplierId,
    supplierName: params.supplierName,
    allowCreate: true,
    allowContainsMatch: true,
    throwOnSupplierIdMiss: Boolean(params.supplierId),
  });
}
