import type { Prisma } from "@prisma/client";
import {
  normalizeSupplierName,
  normalizeSupplierLookupText,
  normalizeSupplierNullableText,
} from "../../../lib/normalize";

export { normalizeSupplierName, normalizeSupplierLookupText, normalizeSupplierNullableText };

export type SupplierSelectShape = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  contactName: string | null;
};

// Use Prisma.TransactionClient field types so that both plain TransactionClient
// and extended-client tx callbacks are assignable without widening to InternalArgs.
export type SupplierMutationClient = {
  supplier: {
    findFirst: Prisma.TransactionClient["supplier"]["findFirst"];
    findMany: Prisma.TransactionClient["supplier"]["findMany"];
    create: Prisma.TransactionClient["supplier"]["create"];
    update: Prisma.TransactionClient["supplier"]["update"];
  };
};

export const SUPPLIER_MUTATION_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  contactName: true,
} as const;

export async function findSupplierByBusinessAndName(
  client: SupplierMutationClient,
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
    select: SUPPLIER_MUTATION_SELECT,
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

export async function createSupplierInTransaction(
  client: SupplierMutationClient,
  options: {
    businessId: string;
    name: string;
    phone?: string | null;
    email?: string | null;
    contactName?: string | null;
  }
): Promise<SupplierSelectShape> {
  const normalizedName = normalizeSupplierName(options.name);
  if (!normalizedName) {
    throw new Error("SUPPLIER_NAME_REQUIRED");
  }

  const existing = await findSupplierByBusinessAndName(
    client,
    options.businessId,
    normalizedName,
    { allowContainsMatch: false }
  );
  if (existing) {
    throw new Error("SUPPLIER_ALREADY_EXISTS");
  }

  return client.supplier.create({
    data: {
      businessId: options.businessId,
      name: normalizedName,
      ...(options.phone != null && { phone: options.phone }),
      ...(options.email != null && { email: options.email }),
      ...(options.contactName != null && { contactName: options.contactName }),
    },
    select: SUPPLIER_MUTATION_SELECT,
  });
}

export async function updateSupplierInTransaction(
  client: SupplierMutationClient,
  options: {
    businessId: string;
    supplierId: string;
    name?: string | null;
    phone?: string | null;
    email?: string | null;
    contactName?: string | null;
  }
): Promise<SupplierSelectShape> {
  const supplier = await client.supplier.findFirst({
    where: { id: options.supplierId, businessId: options.businessId },
    select: SUPPLIER_MUTATION_SELECT,
  });

  if (!supplier) {
    throw new Error("SUPPLIER_NOT_FOUND");
  }

  const normalizedName =
    options.name !== undefined ? normalizeSupplierName(options.name) : null;

  if (options.name !== undefined && !normalizedName) {
    throw new Error("SUPPLIER_NAME_REQUIRED");
  }

  if (normalizedName) {
    const duplicate = await findSupplierByBusinessAndName(
      client,
      options.businessId,
      normalizedName,
      { allowContainsMatch: false }
    );
    if (duplicate && duplicate.id !== options.supplierId) {
      throw new Error("SUPPLIER_ALREADY_EXISTS");
    }
  }

  const updateData: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    contactName?: string | null;
  } = {
    ...(options.phone !== undefined && { phone: normalizeSupplierNullableText(options.phone) }),
    ...(options.email !== undefined && { email: normalizeSupplierNullableText(options.email) }),
    ...(options.contactName !== undefined && {
      contactName: normalizeSupplierNullableText(options.contactName),
    }),
  };

  if (normalizedName) {
    updateData.name = normalizedName;
  }

  // Scope the UPDATE to businessId as a defense-in-depth tenant boundary.
  // The findFirst above already confirmed ownership; this makes the write
  // itself impossible to cross-tenant even if called directly.
  return client.supplier.update({
    where: { id: options.supplierId, businessId: options.businessId },
    data: updateData,
    select: SUPPLIER_MUTATION_SELECT,
  });
}
