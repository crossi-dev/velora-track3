// payment-intent-items.ts — canonical type and runtime validator for the
// PaymentIntent.items JSON column.
//
// Design rationale:
// - Typed at write time: every caller validates through PaymentIntentItemsSchema
//   before persisting. The DB column is opaque JSONB — validation lives here.
// - Mirrors Stripe PaymentIntent line_items shape (productName / quantity /
//   unitPrice / subtotal) and MP Preference.items (title / quantity / unit_price).
// - Additive only: existing null rows fall back to "Pago recibido" in the PDF
//   builder — see buildStandaloneInvoicePayload in notify-customer-pdf-helpers.ts.
//
// Refs:
//   Stripe PaymentIntents API 2026: https://stripe.com/docs/api/payment_intents
//   MP Preference.items schema 2026: https://www.mercadopago.com.ar/developers/es/reference/preferences/_checkout_preferences/post
//   AFIP RG 2485 (CAE) + RG 4291 (QR): itemized receipt mandatory fields.

import { z } from "zod/v3";

// ── Zod schemas (zod/v3 — project convention, matches ADK boundary) ───────────

export const PaymentIntentItemSchema = z.object({
  /** Display name shown on receipt and PDF (e.g. "alfajor", "Envío Andreani"). */
  productName: z.string().min(1).max(200),
  /** Integer quantity. Minimum 1. */
  quantity: z.number().int().min(1),
  // Unit price in ARS. Must be > 0 per AFIP RG 2485 spec (positive line amounts
  // mandatory on fiscal receipts). $0 lines are rejected — free items should be
  // omitted or priced at the minimum billable amount. Min 0.01 enforces this.
  // Ref: AFIP RG 2485 Art. 4 (importe unitario debe ser positivo);
  //      MP Preference.items 2026 — unit_price must be a positive number.
  unitPrice: z.number().min(0.01),
  /** subtotal = quantity × unitPrice. Validated at write time. */
  subtotal: z.number().min(0.01),
});

export const PaymentIntentItemsSchema = z
  .array(PaymentIntentItemSchema)
  .min(1)
  .max(50); // Guard against runaway agent calls.

// ── TypeScript types ──────────────────────────────────────────────────────────

export type PaymentIntentItem = z.infer<typeof PaymentIntentItemSchema>;
export type PaymentIntentItems = z.infer<typeof PaymentIntentItemsSchema>;

// ── Runtime helpers ───────────────────────────────────────────────────────────

/**
 * Parses and validates raw JSON from the DB column.
 * Returns the typed array on success, or null when the value is null/undefined
 * or fails validation (backward compat — old rows have null).
 */
export function parsePaymentIntentItems(
  raw: unknown,
): PaymentIntentItems | null {
  if (raw == null) return null;
  const result = PaymentIntentItemsSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/**
 * Validates items array at write time. Returns the validated array or throws
 * a descriptive error that surfaces to the caller (use-case layer).
 */
export function validatePaymentIntentItems(
  items: unknown,
): PaymentIntentItems {
  return PaymentIntentItemsSchema.parse(items);
}

/**
 * Computes the items subtotal (sum of all subtotals).
 * Does NOT include shippingCostARS — caller adds that separately.
 */
export function sumItemSubtotals(items: PaymentIntentItems): number {
  return items.reduce((acc, it) => acc + it.subtotal, 0);
}
