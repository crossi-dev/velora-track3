// Routing branches for triggerFiscalReceipt. Extracted to keep parent ≤ 300 LOC.
// Handles the two non-happy paths: owner-only routing (ARCA setup guidance surfaced
// via structured dataPart) and fallback (empty / "Sin respuesta del modelo" agent reply).
//
// Comprobante interno strategy — Stripe Receipts pattern (2026):
//   "Receipts are always emitted, regardless of whether an invoice was generated."
//   Source: https://stripe.com/docs/receipts
// When ARCA fails or setup is incomplete, both branches generate a non-fiscal
// comprobante interno PDF (documentType="receipt", "sin validez fiscal") and attach
// it to the customer WhatsApp. The customer ALWAYS receives a PDF.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { buildAndAttachReceiptPdf } from "./trigger-fiscal-receipt.pdf";

export interface OwnerRouteInput {
  paymentIntentId: string;
  businessId: string;
  customerName: string;
  phone: string;
  agentText: string;
  /** Required for comprobante interno PDF generation (Stripe Receipts pattern). */
  saleId: string | null;
  monto: number;
  confirmedAt: Date | null;
}

export type OwnerOnlyResult = { ok: false; reason: "setup_guidance" };

/**
 * Owner-only routing branch: write the agent text to the owner chat (owner_only)
 * and send the customer a comprobante interno PDF (non-fiscal receipt) so they
 * always receive proof of payment — Stripe Receipts pattern:
 *   "Receipts are always emitted, regardless of whether an invoice was generated."
 *   https://stripe.com/docs/receipts
 *
 * Triggered when emitInvoiceResult.setupGuidance is non-empty AND not a sandbox reply
 * (structured dataPart check — no prose substring scan).
 *
 * Returns { ok: false, reason: "setup_guidance" } so the caller rolls back
 * comprobanteSentAt via the updateMany WHERE comprobanteSentAt = claimTime pattern.
 * This prevents permanent fiscal suppression when ARCA_REAL_MODE=true but credentials
 * are not yet set up — the retry cron will re-enter after credentials are configured.
 *
 * Mirrors the B8 fix for routeFiscalFallback (ok:true → ok:false).
 * Ref: cloud.google.com/tasks/docs/creating-http-target-tasks (retry semantics —
 * only stamp idempotency keys on confirmed success, not on transient setup states).
 */
export async function routeFiscalOwnerOnly(input: OwnerRouteInput): Promise<OwnerOnlyResult> {
  const { paymentIntentId, businessId, customerName, phone, agentText, saleId, monto, confirmedAt } = input;

  const ownerMsgId = `fiscal-owner-alert-${paymentIntentId}`;
  try {
    await prisma.chatMessage.create({
      data: {
        businessId,
        clientMessageId: ownerMsgId,
        kind: "reply",
        source: "manager",
        visibility: "owner_only",
        text: `ℹ️ Aviso sobre comprobante (intent ${paymentIntentId}):\n\n${agentText.slice(0, 1200)}`,
      },
    });
  } catch (chatErr) {
    const code = (chatErr as { code?: string } | null)?.code;
    if (code !== "P2002") {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "FISCAL_OWNER_ALERT_WRITE_FAILED",
        a2a_transfer: false,
        message: "Could not write fiscal owner alert to chat",
        data: { paymentIntentId },
        businessId,
      });
    }
  }
  cloudLog({
    severity: "INFO",
    component: "System",
    // FISCAL_RECEIPT_TIER2_COMPROBANTE: ARCA setup incomplete — emitting comprobante interno.
    action: "FISCAL_RECEIPT_TIER2_COMPROBANTE",
    a2a_transfer: false,
    message: "Fiscal agent: ARCA setup incomplete — emitting tier-2 comprobante interno PDF to customer",
    data: { paymentIntentId, tier2Reason: "missing_arca_credentials" },
    businessId,
  });

  // Tier-2: always attach a comprobante interno PDF (non-fiscal receipt).
  // buildAndAttachReceiptPdf uses documentType="receipt" → "COMPROBANTE / sin validez fiscal".
  // Best-effort: falls back to text-only on any PDF error (non-fatal).
  let mediaUrl: string | undefined;
  try {
    mediaUrl = await buildAndAttachReceiptPdf({
      paymentIntentId,
      businessId,
      saleId,
      monto,
      customerName,
      phone,
      confirmedAt,
    });
  } catch {
    // Non-fatal — proceed without PDF attachment.
  }

  const tierMsg = `¡Hola ${customerName}! Tu pago fue confirmado. Adjuntamos tu comprobante de pago (sin validez fiscal).`;
  try {
    await sendWhatsAppMessage(phone, tierMsg, mediaUrl, businessId);
  } catch (wppErr) {
    // Non-fatal — owner already notified. Stamp proceeds upstream.
    // Log at WARNING so GCL alerts can surface delivery failures.
    // Matches pattern at trigger-fiscal-receipt.ts FISCAL_RECEIPT_WHATSAPP_FAILED.
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "FISCAL_OWNER_ACK_WHATSAPP_FAILED",
      a2a_transfer: false,
      message: `Owner-route comprobante interno WPP send failed: ${wppErr instanceof Error ? wppErr.message : String(wppErr)}`,
      data: { paymentIntentId, phone: `...${phone.slice(-4)}`, pdfAttached: Boolean(mediaUrl) },
      businessId,
    });
  }
  // Return !ok so the caller (triggerFiscalReceipt) rolls back comprobanteSentAt.
  // The retry cron will re-enter once ARCA credentials are configured.
  return { ok: false, reason: "setup_guidance" };
}

export type FallbackResult = { ok: false; reason: string };

/**
 * Fallback branch: agent returned empty or known fallback string.
 * Emits a comprobante interno PDF (non-fiscal receipt) and attaches it to
 * the customer WhatsApp — Stripe Receipts pattern:
 *   "Receipts are always emitted, regardless of whether an invoice was generated."
 *   https://stripe.com/docs/receipts
 *
 * Returns { ok: false, reason: "agent_fallback" } so the caller rolls back
 * comprobanteSentAt and the retry cron can re-enter (transient ADK failures).
 *
 * Returning ok:true here was a bug — it permanently suppressed retries
 * for any transient drain (maxLlmCalls, timeout, model error).
 * Fix aligns with the exception path in payment-intent-post-confirm.link.ts
 * which already rolls back the stamp on !ok.
 *
 * Ref: Google Cloud Tasks retry semantics 2026 — only stamp idempotency
 * keys on confirmed success, not on transient fallbacks.
 * cloud.google.com/tasks/docs/creating-http-target-tasks
 */
export async function routeFiscalFallback(input: OwnerRouteInput): Promise<FallbackResult> {
  const { paymentIntentId, businessId, customerName, phone, agentText, saleId, monto, confirmedAt } = input;
  cloudLog({
    severity: "WARNING",
    component: "System",
    // FISCAL_RECEIPT_TIER2_COMPROBANTE: ADK fallback — emitting comprobante interno.
    action: "FISCAL_RECEIPT_TIER2_COMPROBANTE",
    a2a_transfer: false,
    message: "Fiscal agent returned empty or fallback text — emitting tier-2 comprobante interno PDF to customer",
    data: { paymentIntentId, tier2Reason: "arca_failed", agentText: agentText?.slice(0, 200) ?? "" },
    businessId,
  });

  // Tier-2: always attach a comprobante interno PDF (non-fiscal receipt).
  // buildAndAttachReceiptPdf uses documentType="receipt" → "COMPROBANTE / sin validez fiscal".
  // Best-effort: falls back to text-only on any PDF error (non-fatal).
  let mediaUrl: string | undefined;
  try {
    mediaUrl = await buildAndAttachReceiptPdf({
      paymentIntentId,
      businessId,
      saleId,
      monto,
      customerName,
      phone,
      confirmedAt,
    });
  } catch {
    // Non-fatal — proceed without PDF attachment.
  }

  const fallbackMsg = `¡Hola ${customerName}! Tu pago fue confirmado. Adjuntamos tu comprobante de pago (sin validez fiscal).`;
  try {
    await sendWhatsAppMessage(phone, fallbackMsg, mediaUrl, businessId);
  } catch {
    // Non-fatal — the important part is returning !ok so the stamp is rolled back.
  }
  return { ok: false, reason: "agent_fallback" };
}
