// Orphan-heal helper for create_payment_link replayed turns.
//
// When the idempotency layer replays a "created" outcome but the MP preference
// creation never succeeded (providerRef is null), the intent is orphaned: it has
// a DB row but no checkout URL. This module detects and heals that state by
// re-calling the adapter so the owner gets a real link on retry.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { getPaymentProvider } from "./payment-provider";
import type { CollectionResult } from "./payment-provider";
import { resolveSaleItemsForPreference } from "./mp-preference-sale-items";

export interface HealOrphanParams {
  paymentIntentId: string;
  businessId: string;
  description: string;
  customerName?: string;
  /** Forward to the adapter so the re-created preference expires correctly.
   *  If omitted the adapter uses its own default. */
  expiresInDays?: number;
}

export type HealOrphanResult =
  | { healed: true; collection: CollectionResult }
  | { healed: false }
  | { error: string };

/** Checks if a replayed intent needs healing and calls the adapter if so.
 *  Returns `{ healed: false }` when providerRef is already set (healthy replay).
 *  Returns `{ error }` when the adapter call fails. */
export async function healOrphanedIntent(params: HealOrphanParams): Promise<HealOrphanResult> {
  const { paymentIntentId, businessId, description, customerName, expiresInDays } = params;

  const existing = await prisma.paymentIntent.findFirst({
    where: { id: paymentIntentId, businessId },
    select: { providerRef: true, monto: true, shippingCostARS: true },
  });

  if (!existing) {
    // Row missing entirely — this is data corruption, not a healthy replay.
    // The idempotency layer should have guaranteed the row exists before calling
    // healOrphanedIntent; if it doesn't, returning { healed: false } would
    // silently skip the provider call and send back a misleading "already done"
    // reply to the owner. Returning a structured error forces the caller to
    // surface this as a real failure instead.
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "PAYMENT_LINK_ORPHAN_HEAL_NOT_FOUND",
      a2a_transfer: false,
      message: `healOrphanedIntent: PaymentIntent row missing — possible idempotency desync or deletion`,
      data: { paymentIntentId, businessId },
    });
    return { error: "intent_not_found" };
  }

  if (existing.providerRef) {
    // providerRef already set — the intent was healed in a previous attempt or
    // was never orphaned. Healthy replay: skip the provider call.
    return { healed: false };
  }

  cloudLog({
    severity: "WARNING",
    component: "A2A",
    action: "PAYMENT_LINK_ORPHAN_HEAL",
    a2a_transfer: false,
    message: `orphaned intent (no providerRef) detected on replay — re-calling adapter`,
    data: { paymentIntentId, businessId },
  });

  const adapter = await getPaymentProvider(businessId);
  // existing.monto is a Prisma Decimal — convert properly to avoid passing an object.
  // Decimal.toNumber() returns a JS number; guard against NaN (corrupt DB row).
  const amountARS = existing.monto.toNumber();
  if (!Number.isFinite(amountARS)) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "PAYMENT_LINK_ORPHAN_HEAL_BAD_AMOUNT",
      a2a_transfer: false,
      message: `healOrphanedIntent: monto no es un número finito — abortando heal`,
      data: { paymentIntentId, businessId, monto: String(existing.monto) },
    });
    return { error: "invalid_amount" };
  }
  // Finding 11: shippingCostARS is a Prisma Decimal — use .toNumber() (same as monto above)
  // to avoid silent NaN from Decimal's implicit coercion, then guard against corrupt rows.
  const rawShipping = existing.shippingCostARS ? existing.shippingCostARS.toNumber() : null;
  const shippingCostARS = rawShipping !== null && Number.isFinite(rawShipping) ? rawShipping : null;
  const mpBreakdown = await resolveSaleItemsForPreference({
    businessId,
    paymentIntentId,
    shippingCostARS,
    shippingLabel: shippingCostARS ? `Envío — $${shippingCostARS} ARS` : undefined,
  });

  const result = await adapter.createCollection({
    paymentIntentId,
    amountARS,
    description,
    customerName,
    businessId,
    ...(typeof expiresInDays === "number" ? { expiresInDays } : {}),
    ...(mpBreakdown.items ? { items: mpBreakdown.items } : {}),
    ...(mpBreakdown.shipping ? { shipping: mpBreakdown.shipping } : {}),
  });

  if ("error" in result) {
    return { error: result.error };
  }

  return { healed: true, collection: result };
}
