import type { Prisma } from "@prisma/client";
import {
  normalizeSupplierName,
  normalizeSupplierLookupText,
} from "../../../lib/normalize";

export { normalizeSupplierName, normalizeSupplierLookupText };

type SupplierSelectShape = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  contactName: string | null;
};

// Use Prisma.TransactionClient field types so that both plain TransactionClient
// and extended-client tx callbacks are assignable without widening to InternalArgs.
type SupplierLookupClient = {
  supplier: {
    findFirst: Prisma.TransactionClient["supplier"]["findFirst"];
    findMany: Prisma.TransactionClient["supplier"]["findMany"];
    create: Prisma.TransactionClient["supplier"]["create"];
  };
};

export const SUPPLIER_LOOKUP_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  contactName: true,
} as const;

export async function findSupplierByBusinessAndName(
  client: SupplierLookupClient,
  businessId: string,
  supplierName: string,
  options?: {
    allowContainsMatch?: boolean;
  }
): Promise<SupplierSelectShape | null> {
  const normalizedName = normalizeSupplierName(supplierName);
  if (!normalizedName) return null;

  const lookupName = normalizeSupplierLookupText(normalizedName);
  const allowContainsMatch = options?.allowContainsMatch !== false;

  const existingSuppliers = await client.supplier.findMany({
    where: { businessId },
    select: SUPPLIER_LOOKUP_SELECT,
    take: 500,
  });

  const exactMatch =
    existingSuppliers.find(
      (entry) => normalizeSupplierLookupText(entry.name) === lookupName
    ) ?? null;
  if (exactMatch) return exactMatch;

  if (!allowContainsMatch) return null;

  // Require the search term to be at least 50% of the supplier name length
  // to prevent false positives like "Sol" matching "Girasol SA"
  return (
    existingSuppliers.find((entry) => {
      const normalizedEntry = normalizeSupplierLookupText(entry.name);
      return normalizedEntry.includes(lookupName) && lookupName.length >= normalizedEntry.length * 0.5;
    }) ?? null
  );
}

export async function resolveOrCreateSupplierInTransaction(
  client: SupplierLookupClient,
  options: {
    businessId: string;
    supplierId?: string | null;
    supplierName?: string | null;
    phone?: string | null;
    email?: string | null;
    contactName?: string | null;
    allowCreate?: boolean;
    allowContainsMatch?: boolean;
    throwOnSupplierIdMiss?: boolean;
  }
): Promise<SupplierSelectShape | null> {
  const supplierId = options.supplierId?.trim() ?? "";
  const normalizedName = normalizeSupplierName(options.supplierName ?? "");

  if (supplierId) {
    const supplierById = await client.supplier.findFirst({
      where: { id: supplierId, businessId: options.businessId },
      select: SUPPLIER_LOOKUP_SELECT,
    });

    if (!supplierById && options.throwOnSupplierIdMiss) {
      throw new Error("SUPPLIER_NOT_FOUND");
    }

    if (supplierById) return supplierById;
  }

  if (normalizedName) {
    const matchedSupplier = await findSupplierByBusinessAndName(
      client,
      options.businessId,
      normalizedName,
      {
        allowContainsMatch: options.allowContainsMatch,
      }
    );
    if (matchedSupplier) return matchedSupplier;
  }

  if (options.allowCreate && normalizedName) {
    return client.supplier.create({
      data: {
        businessId: options.businessId,
        name: normalizedName,
        ...(options.phone != null && { phone: options.phone }),
        ...(options.email != null && { email: options.email }),
        ...(options.contactName != null && { contactName: options.contactName }),
      },
      select: SUPPLIER_LOOKUP_SELECT,
    });
  }

  return null;
}
