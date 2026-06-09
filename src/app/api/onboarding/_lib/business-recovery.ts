import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";

// Shared select shape for the onboarding GET. Defined as a const (with `as const`
// on relation modifiers) so Prisma still infers a precise return type at the
// call sites, but the 100-line block lives in exactly one place.
export const BUSINESS_FULL_SELECT = {
  id: true,
  name: true,
  type: true,
  currency: true,
  taxRate: true,
  cuit: true,
  address: true,
  email: true,
  phone: true,
  whatsappPhone: true,
  alias: true,
  openingTime: true,
  closingTime: true,
  ivaCondition: true,
  puntoVenta: true,
  iibb: true,
  activityStart: true,
  workerCount: true,
  openingCash: true,
  allowNegativeStock: true,
  notifyLowStockWa: true,
  firstSaleConfirmed: true,
  createdAt: true,
  postalCode: true,
  courierPreference: true,
  stockMovements: {
    select: {
      id: true,
      productId: true,
      productName: true,
      quantityBefore: true,
      quantityAfter: true,
      delta: true,
      reason: true,
      referenceId: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 30,
  },
  products: {
    where: buildActiveProductWhere(),
    select: {
      id: true,
      name: true,
      price: true,
      sku: true,
      quantity: true,
    },
    orderBy: { name: "asc" },
    take: 500,
  },
  customers: {
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      taxId: true,
      address: true,
      postalCode: true,
      city: true,
    },
    orderBy: { name: "asc" },
    take: 500,
  },
  suppliers: {
    select: {
      id: true,
      name: true,
      phone: true,
      contactName: true,
      email: true,
      leadTimeDays: true,
    },
    orderBy: { name: "asc" },
    take: 500,
  },
  sales: {
    select: {
      id: true,
      date: true,
      totalAmount: true,
      status: true,
      customer: {
        select: { id: true, name: true },
      },
      saleItems: {
        select: {
          quantity: true,
          unitPrice: true,
          unitCost: true,
          product: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { date: "desc" },
    take: 500,
  },
} as const;

export function findFullBusinessByUserId(userId: string) {
  return prisma.business.findUnique({
    where: { userId },
    select: BUSINESS_FULL_SELECT,
  });
}

// ── Single Business initializer (design §3 / §14.6) ─────────────────────────
//
// All Business creation paths MUST go through initializeBusinessOnboardingState.
// It sets the canonical onboarding-flag defaults so that every new Business row
// starts from an identical known state, regardless of which creation path is used
// (auth stub recovery vs. bulk-import POST vs. ADK agent tool).
//
// The function upserts on the unique `userId` field so a stub created by
// ensurePlaceholderBusiness cannot be duplicated by a subsequent POST import.
// When a stub already exists, the upsert overwrites only the fields provided in
// `update` — leaving onboarding flags untouched (they stay at their DB defaults).
//
// Returns the resulting Business id.
export async function initializeBusinessOnboardingState(
  userId: string,
  fields: {
    name: string;
    type: string;
    taxRate: number;
    currency?: string;
    cuit?: string | null;
    address?: string | null;
    phone?: string | null;
    workerCount?: number;
    openingCash?: number;
    openingTime?: string | null;
    closingTime?: string | null;
  },
): Promise<string> {
  // All onboarding Boolean flags (skippedCatalog, firstSalePromptShown, etc.)
  // carry @default(false) in the schema — no explicit set needed here.
  // If new onboarding flags are added that need a non-schema-default initial
  // value, add them to the create data below (this is the single place to update).
  const created = await prisma.business.upsert({
    where: { userId },
    create: {
      userId,
      name: fields.name,
      type: fields.type,
      taxRate: fields.taxRate,
      currency: fields.currency ?? "ARS",
      cuit: fields.cuit ?? null,
      address: fields.address ?? null,
      phone: fields.phone ?? null,
      workerCount: fields.workerCount ?? 0,
      openingCash: fields.openingCash ?? 0,
      openingTime: fields.openingTime ?? null,
      closingTime: fields.closingTime ?? null,
    },
    update: {
      // When upserting over a stub (name="", type=""), populate the real data.
      // Fields that are already correct on the stub are left as-is by Prisma
      // (setting them to the same value is a no-op at the DB level).
      name: fields.name,
      type: fields.type,
      currency: fields.currency ?? "ARS",
      cuit: fields.cuit ?? null,
      address: fields.address ?? null,
      phone: fields.phone ?? null,
      workerCount: fields.workerCount ?? 0,
      openingCash: fields.openingCash ?? 0,
      openingTime: fields.openingTime ?? null,
      closingTime: fields.closingTime ?? null,
    },
    select: { id: true },
  });
  return created.id;
}

// Recovery: if auth.ts events.createUser failed silently on first OAuth signup
// (Neon hiccup, transient DB error), the user ends up with a User row but no
// Business row, and createUser never re-fires on subsequent signins. Without
// this lazy create, the dashboard would land on the legacy OnboardingChat form
// forever. Idempotent via upsert on the unique userId field — concurrent calls
// hit P2002 path safely because upsert handles the conflict.
export async function ensurePlaceholderBusiness(userId: string): Promise<void> {
  try {
    await initializeBusinessOnboardingState(userId, { name: "", type: "", taxRate: 0 });
  } catch (err: unknown) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "BUSINESS_PLACEHOLDER_RECOVERY_FAILED",
      a2a_transfer: false,
      message: "Failed to lazy-create placeholder Business in onboarding GET",
      businessId: "",
      data: { userId, error: err instanceof Error ? err.message : String(err) },
    });
    throw err;
  }
}
