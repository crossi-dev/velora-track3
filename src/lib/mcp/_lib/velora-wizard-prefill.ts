// src/lib/mcp/_lib/velora-wizard-prefill.ts — resolveWizardPrefill implementation.
//
// Extracted from velora-payments.adapter.ts to stay under the 300-line file-size limit.
// Contains the full logic for resolving product names + prices from the tenant catalog
// and the customer name for the payment-link wizard prefill.
//
// Tenant isolation: businessId ALWAYS comes from the tenantId input field.
// READ-ONLY — no mutations.
//
// Guard: fails fast if any productId is not found in the catalog (never silent price-0 fallback).
// Effective unit price = negotiated unitPriceOverride when present, else catalog price.

import type { ResolveWizardPrefillInput, ResolveWizardPrefillResult } from "./payments-backend.port";
import { prisma } from "@/lib/prisma";

/**
 * Resolves product names + catalog prices and the customer name for the wizard prefill.
 * Returns a typed result (no throw for domain failures).
 * Tenant isolation: businessId always from input.tenantId.
 *
 * No-customer path: when customerId is absent (empty string), only the item catalog
 * lookup runs. The returned prefill has real names + prices but empty customer fields —
 * the owner picks the customer in-widget. The confirm guard stays disabled until
 * customerId is supplied at create_tracked_payment_link time.
 */
export async function resolveWizardPrefillImpl(
  input: ResolveWizardPrefillInput,
): Promise<ResolveWizardPrefillResult> {
  const businessId = input.tenantId; // tenant isolation: always from closure via port input

  const productIds = input.items.map((i) => i.productId);
  const hasCustomer = input.customerId.trim() !== "";

  const [products, customer] = await Promise.all([
    prisma.product.findMany({
      where: { id: { in: productIds }, businessId },
      select: { id: true, name: true, price: true },
    }),
    // Skip DB round-trip when no customerId was supplied (catalog-selector "Cobrar a cliente" path).
    hasCustomer
      ? prisma.customer.findFirst({
          where: { id: input.customerId, businessId },
          select: { name: true },
        })
      : Promise.resolve(null),
  ]);

  // Only fail on customer_not_found when a customerId was actually supplied.
  if (hasCustomer && !customer) {
    return {
      domainError: "customer_not_found",
      errorMessage:
        "No encontré ese cliente en tu negocio. Verificá el cliente antes de abrir el asistente.",
    };
  }

  const byId = new Map(products.map((p) => [p.id, p]));

  // Guard: fail fast if any productId is missing from the catalog (tenant-scoped).
  // Never silently fall back to price 0 or "(producto no encontrado)".
  for (const item of input.items) {
    if (!byId.has(item.productId)) {
      return {
        domainError: "product_not_found",
        errorMessage: `No encontré el producto ${item.productId} en tu catálogo. Resolvé los productos con query_catalog antes de abrir el asistente.`,
      };
    }
  }

  // Effective unit price = negotiated override when present, else catalog price.
  const resolvedItems = input.items.map((i) => {
    const p = byId.get(i.productId);
    // p is guaranteed to exist here — the guard above would have returned if missing.
    const unitPrice =
      typeof i.unitPriceOverride === "number" ? i.unitPriceOverride : Number(p!.price);
    return {
      productId: i.productId,
      quantity: i.quantity,
      name: p!.name,
      unitPrice,
      ...(typeof i.unitPriceOverride === "number" ? { unitPriceOverride: i.unitPriceOverride } : {}),
    };
  });
  const totalARS = resolvedItems.reduce((s, it) => s + it.quantity * it.unitPrice, 0);

  return {
    prefill: {
      description: input.description,
      // No-customer path: empty strings — wizard picker handles selection.
      customerId: hasCustomer ? input.customerId : "",
      customerName: hasCustomer ? customer!.name : "",
      items: resolvedItems,
      totalARS,
    },
  };
}
