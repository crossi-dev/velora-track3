// mp-preference-sale-items.ts — resolves Sale items for MP Checkout Pro preference,
// and exports pure helpers for building the MP items array.
//
// When a PaymentIntent is linked to a Sale (via saleId), the MP preference can
// show a per-product breakdown instead of a single global item. This module
// encapsulates the Prisma query and the item/shipping mapping so the caller
// (payments-agent-tools.ts) stays under the 300-line limit.
//
// When a PaymentIntent has NO saleId (standalone create_payment_link), we map
// the PI.items JSON column (PaymentIntentItem[]) to MpPreferenceItem[] so the
// MP Checkout page shows the actual product list, not "Venta Velora — $XYZ".
//
// MP Preference.items canonical shape (2026):
//   { title: string; quantity: number; unit_price: number; currency_id: "ARS" }
// Ref: https://www.mercadopago.com.ar/developers/es/reference/preferences/_checkout_preferences/post
//
// Also exports:
//   - MpPreferenceItem / MpPreferenceShipping interfaces (canonical types)
//   - buildMpItems() — pure function that validates + converts items to the MP body shape

import { prisma } from "@/lib/prisma";
import { parsePaymentIntentItems } from "@/app/api/payment-intents/_lib/payment-intent-items";
import { cloudLog } from "@/lib/cloud-logger";

// ── Types (re-exported for mp-api-helpers.ts) ─────────────────────────────────

// Line item passed by callers that have Sale data available.
export interface MpPreferenceItem {
  title: string;
  quantity: number;
  unit_price: number;
}

// Optional shipping line — rendered as a separate item in the MP preference.
export interface MpPreferenceShipping {
  cost: number;
  label: string;
}

export interface PreferenceItemBreakdown {
  items?: MpPreferenceItem[];
  shipping?: MpPreferenceShipping;
}

// ── Pure helper: build MP items array ────────────────────────────────────────

/** Converts the caller-supplied breakdown into the shape MP accepts.
 *  When items is empty/undefined falls back to a single global item.
 *  Throws when items are provided but their sum ≠ amountARS (validation). */
export function buildMpItems(params: {
  items?: MpPreferenceItem[];
  shipping?: MpPreferenceShipping;
  amountARS: number;
  description: string;
}): { title: string; quantity: number; unit_price: number; currency_id: string }[] {
  const { items, shipping, amountARS, description } = params;

  if (items && items.length > 0) {
    // Validate: sum(items × qty) + shipping must equal amountARS (1-cent tolerance).
    const itemsTotal = items.reduce((acc, it) => acc + it.unit_price * it.quantity, 0);
    const shippingTotal = shipping?.cost ?? 0;
    const computed = Math.round((itemsTotal + shippingTotal) * 100);
    const expected = Math.round(amountARS * 100);
    if (computed !== expected) {
      throw new Error(
        `MP preference items breakdown mismatch: items(${itemsTotal}) + shipping(${shippingTotal}) = ${itemsTotal + shippingTotal} ≠ amountARS(${amountARS})`,
      );
    }

    return [
      ...items.map((it) => ({
        title: it.title,
        quantity: it.quantity,
        unit_price: it.unit_price,
        currency_id: "ARS",
      })),
      ...(shipping
        ? [{ title: shipping.label, quantity: 1, unit_price: shipping.cost, currency_id: "ARS" }]
        : []),
    ];
  }

  // Fallback: single global item (legacy callers without Sale item data).
  return [{ title: description, quantity: 1, unit_price: amountARS, currency_id: "ARS" }];
}

/**
 * Attempts to load SaleItem rows for the PaymentIntent's linked Sale.
 *
 * Returns `{ items, shipping }` when a Sale with product data is found,
 * OR when a standalone PI has structured items in its `items` JSON column.
 *
 * Returns `{}` (empty object — fallback to single global item in adapter) when:
 *   - Standalone PI with null/empty items column (legacy rows).
 *   - The Sale has no SaleItems (edge case: deleted products).
 *   - Any DB error occurs (fail-open).
 *
 * The shipping line is only included when shippingCostARS > 0.
 */
export async function resolveSaleItemsForPreference(params: {
  businessId: string;
  paymentIntentId: string;
  shippingCostARS: number | null;
  shippingLabel?: string;
}): Promise<PreferenceItemBreakdown> {
  const { businessId, paymentIntentId, shippingCostARS, shippingLabel } = params;

  try {
    // Load the PaymentIntent to get its saleId, items, and shipping fields.
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: paymentIntentId, businessId },
      select: {
        saleId: true,
        businessId: true,
        // Structured items for standalone PIs (saleId = null).
        // MP Preference.items 2026: unit_price must be positive.
        // Ref: https://www.mercadopago.com.ar/developers/es/reference/preferences/_checkout_preferences/post
        items: true,
        shippingCostARS: true,
        shippingCourier: true,
      },
    });

    if (!intent?.saleId) {
      // Standalone PI (create_payment_link with no linked Sale).
      // Map PI.items JSON column → MpPreferenceItem[] so MP Checkout shows the
      // actual product list. Fall back to global item when items is null (legacy rows).
      const parsedItems = parsePaymentIntentItems(intent?.items ?? null);
      if (!parsedItems || parsedItems.length === 0) {
        // Legacy row or items not captured — fall back to single global item.
        return {};
      }

      const mpItems: MpPreferenceItem[] = parsedItems.map((it) => ({
        title: it.productName,
        quantity: it.quantity,
        unit_price: it.unitPrice,
      }));

      // Resolve shipping: prefer explicit param, then fall back to PI column.
      const resolvedCost = (shippingCostARS && shippingCostARS > 0)
        ? shippingCostARS
        : (intent?.shippingCostARS ? Number(intent.shippingCostARS) : null);
      const resolvedLabel = shippingLabel
        ?? (intent?.shippingCourier ? `Envío ${intent.shippingCourier}` : "Envío");

      const shipping = resolvedCost && resolvedCost > 0
        ? { cost: resolvedCost, label: resolvedLabel }
        : undefined;

      return { items: mpItems, ...(shipping ? { shipping } : {}) };
    }

    // Load the Sale's items with their product names (productId nullable → use title fallback).
    // Also load shippingQuoteCost so async-payment preferences include the freight line
    // even when the caller doesn't supply an explicit shippingCostARS.
    //
    // RLS-verify audit: compound where with intent.businessId — OWASP secure-by-default tenant
    // isolation. intent.businessId is already loaded from the tenant-scoped findFirst above.
    const sale = await prisma.sale.findFirst({
      where: { id: intent.saleId, businessId: intent.businessId },
      select: {
        shippingQuoteCost: true,
        shippingQuoteCourier: true,
        saleItems: {
          select: {
            quantity: true,
            unitPrice: true,
            product: { select: { name: true } },
          },
        },
      },
    });

    const saleItems = sale?.saleItems ?? [];
    if (saleItems.length === 0) {
      // Sale exists but has no items (e.g. all products deleted). Fall back.
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "MP_PREFERENCE_NO_SALE_ITEMS",
        a2a_transfer: false,
        message: "resolveSaleItemsForPreference: Sale has no SaleItems — falling back to global item",
        data: { businessId, paymentIntentId, saleId: intent.saleId },
      });
      return {};
    }

    const items = saleItems.map((si) => ({
      title: si.product?.name ?? "Producto",
      quantity: si.quantity,
      // Prisma Decimal → number. unit_price on the preference must be a plain number.
      unit_price: Number(si.unitPrice),
    }));

    // Resolve freight cost: prefer explicit param (from caller), then fall back to
    // Sale.shippingQuoteCost set by triggerLogisticaIfShippingData (quote-only path
    // for async payments). This ensures the MP preference includes shipping even
    // when the create_payment_link tool doesn't supply shippingCostARS directly.
    const resolvedShippingCost = (shippingCostARS && shippingCostARS > 0)
      ? shippingCostARS
      : (sale?.shippingQuoteCost ? Number(sale.shippingQuoteCost) : null);
    const resolvedShippingLabel = shippingLabel
      ?? (sale?.shippingQuoteCourier ? `Envío ${sale.shippingQuoteCourier}` : "Envío");

    const shipping =
      resolvedShippingCost && resolvedShippingCost > 0
        ? { cost: resolvedShippingCost, label: resolvedShippingLabel }
        : undefined;

    return { items, ...(shipping ? { shipping } : {}) };
  } catch (err) {
    // Fail-open: log and return empty so the adapter falls back to single global item.
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "MP_PREFERENCE_SALE_ITEMS_ERROR",
      a2a_transfer: false,
      message: "resolveSaleItemsForPreference: unexpected error — falling back to global item",
      data: { businessId, paymentIntentId, error: err instanceof Error ? err.message : String(err) },
    });
    return {};
  }
}
