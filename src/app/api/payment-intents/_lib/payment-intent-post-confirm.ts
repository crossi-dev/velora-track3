// Post-confirm side-effects — orquesta comprobante + envío después de que
// el webhook (o el owner) confirma un PaymentIntent.
// Camino A: checkout_pro_link → runLinkPaymentPostConfirm (owner notify + PDF + envío)
// Camino B: cualquier otro    → notifyCustomerOnConfirm (PDF WPP) +
//                               runShipmentChain si shippingRequired=true (transferencia/qr)
// Idempotencia: comprobanteSentAt / shipmentCreatedAt como gatekeepers.
// Fire-and-forget: fallos de Twilio/Logística no propagan a la respuesta HTTP.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { notifyCustomerOnConfirm } from "./notify-customer-on-confirm";
import { runLinkPaymentPostConfirm, runShipmentChain } from "./payment-intent-post-confirm.link";
import { notifyOwnerOnPayment } from "./notify-owner-on-payment";

// Re-export for backwards-compat (payment-intent-use-case previously imported this).
export { notifyCustomerOnConfirm };

// Finding #10: named constant eliminates magic string comparison.
export const CHECKOUT_PRO_LINK_METODO = "checkout_pro_link" as const;

// ── Entry point unificado — invocado por payment-intent-use-case ──────────────

/**
 * Despacha los side-effects post-confirm según el tipo de PaymentIntent.
 *
 * - checkout_pro_link → runLinkPaymentPostConfirm (PDF + envío)
 * - cualquier otro    → notifyCustomerOnConfirm  (texto plano, legacy QR cobro)
 */
export async function runPostConfirmSideEffects(
  paymentIntentId: string,
  callerBusinessId: string,
): Promise<void> {
  // findFirst with compound where — OWASP secure-by-default tenant isolation.
  // callerBusinessId is required (H2 fix: removes optional-param footgun).
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: paymentIntentId, businessId: callerBusinessId },
    select: {
      id: true,
      metodo: true,
      businessId: true,
      saleId: true,
      comprobanteSentAt: true,
      shippingRequired: true,
      shipmentCreatedAt: true,
      trackingWppSentAt: true,
      matchedCustomerId: true,
      shippingAddress: true,
    },
  });

  if (!intent) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "POST_CONFIRM_INTENT_NOT_FOUND",
      a2a_transfer: false,
      message: "runPostConfirmSideEffects: intent not found — skipping",
      data: { paymentIntentId },
    });
    return;
  }

  if (intent.metodo === CHECKOUT_PRO_LINK_METODO) {
    await runLinkPaymentPostConfirm(intent);
  } else {
    // G #1: Notify owner on all confirmed payments (qr/transferencia),
    // mirroring the checkout_pro_link path. Best-effort, fire-and-forget.
    void notifyOwnerOnPayment(paymentIntentId, intent.businessId).catch((err) => {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "OWNER_PAYMENT_NOTIFY_FAILED",
        a2a_transfer: false,
        message: `notifyOwnerOnPayment failed: ${err instanceof Error ? err.message : String(err)}`,
        // Finding #12: businessId at top level for GCL routing filters.
        businessId: intent.businessId,
        data: { paymentIntentId },
      });
    });

    // Comprobante (PDF WPP to customer) — gated by comprobanteSentAt inside.
    await notifyCustomerOnConfirm(paymentIntentId, intent.businessId);

    // Then shipment+tracking — applies to transferencia/qr/any metodo
    // when the sale has shippingRequired. Gated by shipmentCreatedAt for
    // idempotency across retries.
    if (intent.shippingRequired && !intent.shipmentCreatedAt) {
      await runShipmentChain(intent);
    }
  }
}
