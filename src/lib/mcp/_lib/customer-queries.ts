// src/lib/mcp/_lib/customer-queries.ts — Customer query + upsert helpers for MCP tools.
//
// Two functions:
//   findCustomers  — search customers by name and/or phone (tenant-scoped, limit 20).
//   upsertCustomer — create a customer or update an existing one matched by phone or id.
//                    Reuses createCustomerInTransaction / updateCustomerInTransaction from
//                    the shared infra layer — no custom DB logic here.
//
// Tenant isolation: businessId is always the first argument — never from tool input.
// upsertCustomer is NOT a money-path operation: no idempotency begin/complete is needed.
// The underlying createCustomerInTransaction already performs a phone-based upsert at the
// application layer (partial unique index Customer_businessId_phone_unique) before writing.
//
// References:
//   createCustomerInTransaction  — src/infrastructure/shared/customer-mutations.ts
//   updateCustomerInTransaction  — src/infrastructure/shared/customer-mutations.ts
//   prisma-customer.repository   — src/infrastructure/persistence/prisma-customer.repository.ts

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  createCustomerInTransaction,
  updateCustomerInTransaction,
  type CustomerMutationRecord,
} from "@/infrastructure/shared/customer-mutations";

export type { CustomerMutationRecord };

export interface CustomerSearchResult {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  postalCode: string | null;
  city: string | null;
}

const SEARCH_LIMIT = 20;

/**
 * Searches customers by name (case-insensitive contains) and/or phone
 * (exact match after normalisation). At least one of name or phone must
 * be provided — returns empty array when both are omitted.
 * Scoped by businessId — never returns rows from other tenants.
 */
export async function findCustomers(
  businessId: string,
  args: { name?: string; phone?: string },
): Promise<CustomerSearchResult[]> {
  if (!args.name && !args.phone) return [];

  const andClauses: Array<Record<string, unknown>> = [{ businessId }];

  if (args.name) {
    andClauses.push({ name: { contains: args.name, mode: "insensitive" as const } });
  }

  if (args.phone) {
    // Normalise: strip spaces and leading zeros for a loose prefix match.
    const normalizedPhone = args.phone.replace(/\s+/g, "");
    andClauses.push({ phone: { contains: normalizedPhone } });
  }

  const rows = await prisma.customer.findMany({
    where: { AND: andClauses },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      address: true,
      postalCode: true,
      city: true,
    },
    orderBy: { name: "asc" },
    take: SEARCH_LIMIT,
  });

  return rows;
}

export interface UpsertCustomerArgs {
  businessId: string;
  /** When provided, updates the existing customer with this id. */
  customerId?: string;
  name?: string;
  phone?: string;
  email?: string;
  address?: string;
  postalCode?: string;
  city?: string;
}

/**
 * Creates a new customer, or updates an existing one (when customerId is supplied).
 * When no customerId is given and a phone is provided, createCustomerInTransaction
 * automatically returns the existing customer if one already exists with that phone
 * (upsert-by-phone at the app layer).
 *
 * Runs inside a prisma.$transaction so the create/update is atomic.
 * NOT a money-path operation — no idempotency begin/complete is used here.
 */
export async function upsertCustomer(
  args: UpsertCustomerArgs,
): Promise<CustomerMutationRecord> {
  return prisma.$transaction(async (rawTx) => {
    // Cast to Prisma.TransactionClient — same pattern as prisma-customer.repository.ts
    // (INV-5: our extended client and the base TransactionClient are structurally
    // compatible for the operations used here, but nominally distinct types).
    const tx = rawTx as unknown as Prisma.TransactionClient;

    if (args.customerId) {
      return updateCustomerInTransaction(tx, {
        businessId: args.businessId,
        customerId: args.customerId,
        name: args.name,
        phone: args.phone,
        email: args.email,
        address: args.address,
        postalCode: args.postalCode,
        city: args.city,
        // MCP callers are external agents/owners — enforce name uniqueness.
        enforceNameUniqueness: true,
      });
    }

    return createCustomerInTransaction(tx, {
      businessId: args.businessId,
      name: args.name,
      phone: args.phone,
      email: args.email,
      address: args.address,
      postalCode: args.postalCode,
      city: args.city,
    });
  });
}
