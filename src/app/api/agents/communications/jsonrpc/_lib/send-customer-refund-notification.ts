// send-customer-refund-notification.ts — Communications-layer helper for reverse-cascade WPP.
//
// Single point of egress for customer-facing WhatsApp refund / return / undo-sale messages.
// Mirrors the fire-and-forget best-effort pattern of sendCustomerTrackingWpp — never throws
// to caller; all failures are logged as WARNING so the committed DB state is never rolled back.
//
// Three reverse-cascade reasons:
//   "refund"    — cash refund on a confirmed PaymentIntent (slice 5 V1).
//   "return"    — physical product return registered against a Sale.
//   "undo_sale" — chat "deshacer venta" cascade (undo-handlers/sale.ts).
//
// Atomic-claim stamp (idempotency):
//   PaymentIntent.refundNotificationSentAt — claimed BEFORE send for "refund" reason.
//   Sale.undoNotificationSentAt            — claimed BEFORE send for "undo_sale" reason.
//   "return" path has no dedicated stamp yet (V1 — single entry point, low retry risk).
//
// WhatsApp outbound API (Twilio sandbox / Meta Cloud API):
//   Ref: https://www.twilio.com/docs/whatsapp/api (verified 2026-05-27)
//   Ref: https://www.twilio.com/docs/glossary/what-e164 (E.164 phone format)
// Phone numbers MUST be in E.164 format (e.g. +5491112345678).
// sendWhatsAppMessage() in lib/whatsapp.ts enforces this — no conversion needed here.
//
// Google ADK A2A 2026: in-process direct import is canonical for helpers within the
// same Cloud Run service. Ref: https://google.github.io/adk-docs/agents/multi-agents/#agent-to-agent

import { cloudLog } from "@/lib/cloud-logger";
import { sendWhatsAppMessage } from "@/lib/whatsapp";

export type RefundNotificationReason = "refund" | "return" | "undo_sale";

export interface SendCustomerRefundNotificationParams {
  businessId: string;
  customerPhone: string;
  customerName: string | null;
  businessName: string;
  amount: number;
  reason: RefundNotificationReason;
  /** Reference ID for log correlation — paymentIntentId for "refund", saleId for others. */
  referenceId: string;
}

const ART_LOCALE = "es-AR";
const AMOUNT_FMT = new Intl.NumberFormat(ART_LOCALE, {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function buildMessage(
  reason: RefundNotificationReason,
  customerName: string | null,
  businessName: string,
  amount: number,
): string {
  const name = customerName ?? "cliente";
  const formatted = AMOUNT_FMT.format(amount);

  switch (reason) {
    case "refund":
      return `Hola ${name}, te confirmamos que procesamos el reintegro de $${formatted} de tu compra en ${businessName}. ¡Gracias!`;
    case "return":
      return `Hola ${name}, registramos la devolución de tu compra en ${businessName} ($${formatted}). ¡Gracias!`;
    case "undo_sale":
      return `Hola ${name}, anulamos tu compra en ${businessName} ($${formatted}). Si fue por error, contactanos.`;
  }
}

/**
 * Sends a WhatsApp reversal notification to the customer.
 * Best-effort — NEVER throws to caller. All errors are logged as WARNING.
 * The committed DB state (refund / return / undo) is never rolled back on WPP failure.
 *
 * Callers are responsible for the atomic-claim stamp BEFORE calling this function
 * (mirror of sendCustomerTrackingWpp pattern).
 */
export async function sendCustomerRefundNotification(
  params: SendCustomerRefundNotificationParams,
): Promise<void> {
  const { businessId, customerPhone, customerName, businessName, amount, reason, referenceId } = params;

  if (!customerPhone) {
    // Silent skip — consistent with fiscal receipt skip-no-phone pattern.
    return;
  }

  const message = buildMessage(reason, customerName, businessName, amount);

  try {
    await sendWhatsAppMessage(customerPhone, message);
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "CUSTOMER_REFUND_NOTIFICATION_SENT",
      a2a_transfer: false,
      message: `Refund/reversal WPP sent (reason=${reason}) ref=${referenceId}`,
      data: {
        referenceId,
        reason,
        phone: `...${customerPhone.slice(-4)}`,
      },
      businessId,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "CUSTOMER_REFUND_NOTIFICATION_FAILED",
      a2a_transfer: false,
      message: `CUSTOMER_REFUND_NOTIFICATION_FAILED (reason=${reason}): ${error}`,
      data: {
        referenceId,
        reason,
        phone: `...${customerPhone.slice(-4)}`,
        error,
      },
      businessId,
    });
    // Do NOT re-throw — WPP failure must never roll back a committed refund/undo.
  }
}
