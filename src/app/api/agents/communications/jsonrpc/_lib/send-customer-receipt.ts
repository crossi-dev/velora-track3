// send-customer-receipt.ts — Communications-layer helper for customer receipt WPP.
//
// Single point of egress for customer-facing WhatsApp comprobante/receipt messages.
// Mirrors the fire-and-forget pattern of sendCustomerTrackingWpp (in-process,
// best-effort, never throws to caller).
//
// Design: Google ADK A2A 2026 recommends a single execution point per
// communication channel — all customer-facing WPP sends are owned by the
// Communications agent so audit, observability, provider fallback, and rate
// limits are enforced in one place.
// Ref: https://google.github.io/adk-docs/agents/multi-agents/#agent-to-agent
//
// For in-process calls within the same Cloud Run service, direct import is
// canonical (ADK A2A allows logical boundaries without physical HTTP hops).
// This matches the existing sendCustomerTrackingWpp pattern.
//
// IMPORTANT: This helper only handles the WPP send. The atomic claim (CAS on
// comprobanteSentAt) and rollback semantics remain in notify-customer-on-confirm.ts
// — the caller stamps BEFORE calling this, rolls back if this throws.

import { cloudLog } from "@/lib/cloud-logger";
import { sendWhatsAppMessage } from "@/lib/whatsapp";

export interface SendCustomerReceiptParams {
  businessId: string;
  customerPhone: string;
  customerName: string | null;
  paymentIntentId: string;
  monto: number;
  pdfMediaUrl?: string;
}

// Return type is void — function always throws on failure (callers use try/catch).
// The ok/error shape was dead code: the catch block always rethrows, so { ok: false }
// was never actually returned to any caller.

const ART_LOCALE = "es-AR";
const CURRENCY_FMT = new Intl.NumberFormat(ART_LOCALE, {
  style: "currency",
  currency: "ARS",
});

/**
 * Builds the receipt WhatsApp message.
 * Preserves exact copy from notify-customer-on-confirm.ts buildConfirmMessage.
 */
function buildReceiptMessage(
  monto: number,
  customerName: string | null,
  hasPdf: boolean,
): string {
  const greeting = customerName ? `Hola ${customerName}!` : "Hola!";
  const amountFormatted = CURRENCY_FMT.format(monto);
  const lines = [
    greeting,
    `Recibimos tu pago de *${amountFormatted}*.`,
    hasPdf ? "Adjunto tu comprobante." : undefined,
    "Gracias por tu compra!",
  ];
  return lines.filter((l): l is string => l !== undefined).join("\n");
}

/**
 * Sends a WhatsApp receipt/comprobante message to the customer.
 * Single execution point for the Comms agent.
 *
 * THROWS on WPP send failure — callers that implement atomic-claim/rollback
 * (e.g. notify-customer-on-confirm.ts) must catch and roll back the stamp.
 */
export async function sendCustomerReceipt(
  params: SendCustomerReceiptParams,
): Promise<void> {
  const { businessId, customerPhone, customerName, paymentIntentId, monto, pdfMediaUrl } = params;

  const message = buildReceiptMessage(monto, customerName, Boolean(pdfMediaUrl));

  try {
    await sendWhatsAppMessage(customerPhone, message, pdfMediaUrl);
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "COMM_RECEIPT_SENT",
      a2a_transfer: false,
      message: `Receipt WPP sent to customer for intent ${paymentIntentId} (pdfAttached=${Boolean(pdfMediaUrl)})`,
      data: {
        paymentIntentId,
        phone: `...${customerPhone.slice(-4)}`,
        pdfAttached: Boolean(pdfMediaUrl),
      },
      businessId,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "COMM_RECEIPT_SEND_FAILED",
      a2a_transfer: false,
      message: `Receipt WPP send failed: ${error}`,
      data: {
        paymentIntentId,
        phone: `...${customerPhone.slice(-4)}`,
        error,
      },
      businessId,
    });
    // Re-throw so callers can roll back atomic claims.
    throw err;
  }
}
