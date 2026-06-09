import type { Prisma } from "@prisma/client";
import {
  normalizeCustomerName,
  normalizeCustomerNullableText,
} from "@/lib/normalize";

export { normalizeCustomerName, normalizeCustomerNullableText };

type CustomerMutationClient = Prisma.TransactionClient;

export type CustomerMutationRecord = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  taxId: string | null;
  dni: string | null;
  ivaCondition: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
};

function ensureCustomerName(value: unknown, fallback?: string) {
  const normalized = normalizeCustomerName(value);
  if (!normalized) {
    if (fallback) return fallback;
    throw new Error("CUSTOMER_NAME_REQUIRED");
  }
  return normalized;
}

function selectCustomerRecord(customer: {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  taxId: string | null;
  dni: string | null;
  ivaCondition: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}): CustomerMutationRecord {
  return {
    id: customer.id,
    name: customer.name,
    phone: customer.phone,
    email: customer.email,
    taxId: customer.taxId,
    dni: customer.dni,
    ivaCondition: customer.ivaCondition,
    address: customer.address,
    postalCode: customer.postalCode,
    city: customer.city,
  };
}

async function ensureCustomerNameIsUnique(
  tx: CustomerMutationClient,
  args: { businessId: string; name: string; excludeCustomerId?: string }
) {
  const duplicate = await tx.customer.findFirst({
    where: {
      businessId: args.businessId,
      name: args.name,
      ...(args.excludeCustomerId ? { id: { not: args.excludeCustomerId } } : {}),
    },
    select: { id: true },
  });

  if (duplicate) {
    throw new Error("CUSTOMER_ALREADY_EXISTS");
  }
}

export async function createCustomerInTransaction(
  tx: CustomerMutationClient,
  args: {
    businessId: string;
    name?: unknown;
    phone?: unknown;
    email?: unknown;
    taxId?: unknown;
    dni?: unknown;
    ivaCondition?: unknown;
    address?: unknown;
    postalCode?: unknown;
    city?: unknown;
  }
): Promise<CustomerMutationRecord> {
  // Derive a display name from available identifiers if no explicit name was provided.
  // Priority: name > phone > email > taxId > generic placeholder.
  const nameFallback =
    (typeof args.phone === "string" && args.phone.trim()) ||
    (typeof args.email === "string" && args.email.trim()) ||
    (typeof args.taxId === "string" && args.taxId.trim()) ||
    "Cliente";
  const name = ensureCustomerName(args.name, nameFallback);
  const normalizedPhone = normalizeCustomerNullableText(args.phone);

  // True upsert-by-phone: if a customer with this phone already exists in the
  // business, return that record instead of creating a duplicate. This enforces
  // the DB partial unique index (Customer_businessId_phone_unique) at the
  // application layer before the write, giving a clear error-free return path
  // rather than a constraint violation. NULL phones skip this check — two
  // customers without phones are both legal (the index only fires on non-NULL).
  if (normalizedPhone) {
    const existingByPhone = await tx.customer.findFirst({
      where: { businessId: args.businessId, phone: normalizedPhone },
      select: { id: true, name: true, phone: true, email: true, taxId: true, dni: true, ivaCondition: true, address: true, postalCode: true, city: true },
    });
    if (existingByPhone) {
      return selectCustomerRecord(existingByPhone);
    }
  }

  await ensureCustomerNameIsUnique(tx, { businessId: args.businessId, name });

  const created = await tx.customer.create({
    data: {
      businessId: args.businessId,
      name,
      phone: normalizedPhone,
      email: normalizeCustomerNullableText(args.email),
      taxId: normalizeCustomerNullableText(args.taxId),
      dni: normalizeCustomerNullableText(args.dni),
      ivaCondition: normalizeCustomerNullableText(args.ivaCondition),
      address: normalizeCustomerNullableText(args.address),
      postalCode: normalizeCustomerNullableText(args.postalCode),
      city: normalizeCustomerNullableText(args.city),
    },
    select: { id: true, name: true, phone: true, email: true, taxId: true, dni: true, ivaCondition: true, address: true, postalCode: true, city: true },
  });

  return selectCustomerRecord(created);
}

export async function updateCustomerInTransaction(
  tx: CustomerMutationClient,
  args: {
    businessId: string;
    customerId: string;
    name?: unknown;
    phone?: unknown;
    email?: unknown;
    taxId?: unknown;
    dni?: unknown;
    ivaCondition?: unknown;
    address?: unknown;
    postalCode?: unknown;
    city?: unknown;
    /** When false, skips name-uniqueness enforcement. Used by customer-agent
     *  self-service path: customers are phone-anchored; two can share a name. */
    enforceNameUniqueness?: boolean;
  }
): Promise<CustomerMutationRecord> {
  const customer = await tx.customer.findFirst({
    where: { id: args.customerId, businessId: args.businessId },
    select: { id: true, name: true, phone: true, email: true, taxId: true, dni: true, ivaCondition: true, address: true, postalCode: true, city: true },
  });

  if (!customer) {
    throw new Error("CUSTOMER_NOT_FOUND");
  }

  const updateData: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    taxId?: string | null;
    dni?: string | null;
    ivaCondition?: string | null;
    address?: string | null;
    postalCode?: string | null;
    city?: string | null;
  } = {};

  if (args.name !== undefined) {
    const normalizedName = ensureCustomerName(args.name);
    if (normalizedName !== customer.name) {
      if (args.enforceNameUniqueness !== false) {
        await ensureCustomerNameIsUnique(tx, {
          businessId: args.businessId,
          name: normalizedName,
          excludeCustomerId: customer.id,
        });
      }
      updateData.name = normalizedName;
    }
  }

  if (args.phone !== undefined) {
    updateData.phone = normalizeCustomerNullableText(args.phone);
  }

  if (args.email !== undefined) {
    updateData.email = normalizeCustomerNullableText(args.email);
  }

  if (args.taxId !== undefined) {
    updateData.taxId = normalizeCustomerNullableText(args.taxId);
  }

  if (args.dni !== undefined) {
    updateData.dni = normalizeCustomerNullableText(args.dni);
  }

  if (args.ivaCondition !== undefined) {
    updateData.ivaCondition = normalizeCustomerNullableText(args.ivaCondition);
  }

  if (args.address !== undefined) {
    updateData.address = normalizeCustomerNullableText(args.address);
  }

  if (args.postalCode !== undefined) {
    updateData.postalCode = normalizeCustomerNullableText(args.postalCode);
  }

  if (args.city !== undefined) {
    updateData.city = normalizeCustomerNullableText(args.city);
  }

  if (Object.keys(updateData).length === 0) {
    return selectCustomerRecord(customer);
  }

  // Defense-in-depth tenant guard: scope write by both id+businessId to prevent
  // cross-tenant mutation if customer.id leaked through the prior findFirst.
  const updated = await tx.customer.update({
    where: { id: customer.id, businessId: args.businessId },
    data: updateData,
    select: { id: true, name: true, phone: true, email: true, taxId: true, dni: true, ivaCondition: true, address: true, postalCode: true, city: true },
  });

  return selectCustomerRecord(updated);
}
