// send-customer-payment-link.ts — Communications-layer helper for customer payment-link WPP.
//
// Single point of egress for customer-facing WhatsApp payment link messages.
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
// This matches the existing sendCustomerTrackingWpp pattern imported directly
// by payment-intent-tracking-wpp.ts.
//
// Idempotency: paymentLinkSentAt atomic claim (updateMany WHERE NULL) mirrors
// trackingWppSentAt / comprobanteSentAt patterns to prevent double-send on chip
// double-tap or network-layer retries.
// Ref: Stripe idempotency-keys §atomic-phases, Shopify idempotent mutations 2026.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { publishPostCommitFailure } from "@/app/api/_lib/post-commit-failure-publisher";

export interface SendCustomerPaymentLinkParams {
  businessId: string;
  customerPhone: string;
  customerName: string | null;
  paymentIntentId: string;
  checkoutUrl: string;
  monto: number | null;
  saleDescription?: string | null;
}

export interface SendCustomerPaymentLinkResult {
  ok: boolean;
  error?: string;
}

// Resolved lazily at call time, NOT at module load. Next.js evaluates this
// module during the build's page-data collection phase where Cloud Run runtime
// env vars are NOT available — a top-level throw fails the entire build.
// Ref: Next.js docs — runtime env vars must be read inside request handlers,
// not at module evaluation: https://nextjs.org/docs/app/api-reference/next-config-js/env
function resolveBaseUrl(): string {
  const appUrl = process.env.NEXTAUTH_URL ?? process.env.VELORA_APP_URL;
  if (!appUrl && process.env.NODE_ENV === "production") {
    throw new Error(
      "[send-customer-payment-link] NEXTAUTH_URL and VELORA_APP_URL are both unset in production. " +
      "Set at least one so payment link URLs point to the correct domain."
    );
  }
  return (appUrl ?? "https://somosvelora.com").replace(/\/$/, "");
}

function buildVeloraLandingUrl(intentId: string): string {
  return `${resolveBaseUrl()}/pay/${intentId}`;
}

function formatArs(amount: number): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
  }).format(amount);
}

function buildPaymentLinkMessage(
  params: Pick<
    SendCustomerPaymentLinkParams,
    "customerName" | "paymentIntentId" | "monto" | "saleDescription"
  >,
): string {
  const landingUrl = buildVeloraLandingUrl(params.paymentIntentId);
  const name = params.customerName?.split(" ")[0] ?? null;
  const montoFormatted = params.monto != null ? formatArs(params.monto) : null;

  // Preserve exact copy from execute-payment-link-send.ts buildWappMessage.
  if (name && montoFormatted && params.saleDescription) {
    return `Hola ${name}! Te paso el link para pagar ${montoFormatted} por ${params.saleDescription}: ${landingUrl}`;
  }
  if (name && montoFormatted) {
    return `Hola ${name}! Tu link de pago de ${montoFormatted}: ${landingUrl}`;
  }
  if (montoFormatted) {
    return `Tu link de pago de ${montoFormatted}: ${landingUrl}`;
  }
  return `Tu link de pago: ${landingUrl}`;
}

/**
 * Sends a WhatsApp payment-link message to the customer.
 * Single execution point for the Comms agent — best-effort, never throws.
 *
 * Idempotency: claims paymentLinkSentAt atomically before sending.
 * count===0 → already claimed by another request → return early with ack.
 * On WPP failure → rolls back the stamp so the next attempt can retry.
 * Pattern mirrors claimAndSendTrackingWpp in payment-intent-tracking-wpp.ts.
 */
export async function sendCustomerPaymentLink(
  params: SendCustomerPaymentLinkParams,
): Promise<SendCustomerPaymentLinkResult> {
  const { businessId, customerPhone, paymentIntentId } = params;

  // ── Atomic claim ─────────────────────────────────────────────────────────
  const claimTime = new Date();
  const claim = await prisma.paymentIntent.updateMany({
    where: { id: paymentIntentId, paymentLinkSentAt: null },
    data: { paymentLinkSentAt: claimTime },
  });

  if (claim.count === 0) {
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "COMM_PAYMENT_LINK_ALREADY_SENT",
      a2a_transfer: false,
      message: `paymentLinkSentAt already stamped — skipping duplicate payment link WPP for intent ${paymentIntentId}`,
      data: { paymentIntentId, phone: `...${customerPhone.slice(-4)}` },
      businessId,
    });
    return { ok: true };
  }

  const message = buildPaymentLinkMessage(params);

  try {
    await sendWhatsAppMessage(customerPhone, message);
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "COMM_PAYMENT_LINK_SENT",
      a2a_transfer: false,
      message: `Payment link WPP sent to customer for intent ${paymentIntentId}`,
      data: { paymentIntentId, phone: `...${customerPhone.slice(-4)}` },
      businessId,
    });
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "COMM_PAYMENT_LINK_SEND_FAILED",
      a2a_transfer: false,
      message: `Payment link WPP send failed — rolling back paymentLinkSentAt claim: ${error}`,
      data: { paymentIntentId, phone: `...${customerPhone.slice(-4)}`, error },
      businessId,
    });
    // ── Rollback claim on WPP failure so next attempt can re-enter ─────────
    // If rollback also fails (DB blip), log CRITICAL + dead-letter via
    // publishPostCommitFailure. Mirrors B9 claimAndSendTrackingWpp pattern.
    try {
      await prisma.paymentIntent.updateMany({
        where: { id: paymentIntentId, paymentLinkSentAt: claimTime },
        data: { paymentLinkSentAt: null },
      });
    } catch (rollbackErr) {
      const rollbackMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      cloudLog({
        severity: "CRITICAL",
        component: "A2A",
        action: "COMM_PAYMENT_LINK_ROLLBACK_FAILED",
        a2a_transfer: false,
        message: `sendCustomerPaymentLink: rollback failed — paymentLinkSentAt may be permanently stale: ${rollbackMsg}`,
        data: { paymentIntentId, phone: `...${customerPhone.slice(-4)}` },
        businessId,
      });
      void publishPostCommitFailure({
        businessId,
        saleId: null,
        action: "COMM_PAYMENT_LINK_ROLLBACK_FAILED",
        errorMessage: rollbackMsg,
        originalArgs: { paymentIntentId },
      });
    }
    return { ok: false, error };
  }
}
