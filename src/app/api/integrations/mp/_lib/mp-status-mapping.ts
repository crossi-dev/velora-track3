// mp-status-mapping.ts — Canonical MercadoPago payment status mapping.
//
// Single source of truth for the full MP status enum:
//   https://www.mercadopago.com.ar/developers/en/docs/checkout-api/response-handling/query-results
//
// Status enum (MP official, 2026):
//   approved           → money accredited (pay-now)
//   authorized         → payment guaranteed; MP captures/clears later
//                        (credit card deferred installments — accrual-basis revenue)
//   in_process         → MP is reviewing; will resolve to approved or rejected later
//   in_mediation       → buyer initiated dispute mediation
//   pending            → buyer has not finished checkout
//   rejected           → payment declined (insufficient funds, card issue, etc.)
//   cancelled          → cancelled by buyer/seller before processing
//   refunded           → fully refunded
//   partially_refunded → partial refund issued
//   charged_back       → chargeback initiated by buyer
//
// Used by:
//   - mp-adapter.ts (getStatus — chat-facing get_payment_status tool)
//   - mp-payment-reconcile-runner.ts (reconcile cron)

// ── Status sets ───────────────────────────────────────────────────────────────

/** Statuses that represent a successfully committed payment. */
export const CONFIRMABLE_STATUSES = new Set(["approved", "authorized"]);

/** Statuses that mean MP is still reviewing — leave as pending and retry. */
export const REVIEWING_STATUSES = new Set(["in_process", "in_mediation", "pending"]);

/** Terminal rejection statuses — payment will not proceed. */
export const REJECTED_STATUSES = new Set(["rejected", "cancelled"]);

/** Refund or chargeback statuses — post-payment reversal path. */
export const REFUND_DISPUTE_STATUSES = new Set(["refunded", "partially_refunded", "charged_back"]);

// ── Velora canonical status type ─────────────────────────────────────────────

export type VeloraPaymentStatus =
  | "approved"   // paid and confirmed
  | "pending"    // in-flight or under review
  | "rejected"   // terminal failure
  | "refunded"   // reversed post-payment
  | "disputed";  // chargeback in progress

// ── Mapping function ──────────────────────────────────────────────────────────

/**
 * Maps an MP payment status string to a Velora canonical status.
 *
 * - `approved` / `authorized`          → "approved"
 * - `in_process` / `in_mediation` / `pending` → "pending"
 * - `rejected` / `cancelled`           → "rejected"
 * - `refunded` / `partially_refunded`  → "refunded"
 * - `charged_back`                     → "disputed"
 * - anything unknown                   → "pending" (safe default; log caller)
 */
export function mapMpStatusToVeloraStatus(mpStatus: string): VeloraPaymentStatus {
  if (CONFIRMABLE_STATUSES.has(mpStatus)) return "approved";
  if (REVIEWING_STATUSES.has(mpStatus)) return "pending";
  if (REJECTED_STATUSES.has(mpStatus)) return "rejected";
  if (mpStatus === "refunded" || mpStatus === "partially_refunded") return "refunded";
  if (mpStatus === "charged_back") return "disputed";
  // Unknown status — safe fallback; caller should log this case.
  return "pending";
}
