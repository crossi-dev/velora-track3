// send-customer-tracking-wpp.ts — Communications-layer helper for customer shipment WPP.
//
// Single point of egress for customer-facing WhatsApp tracking messages.
// Mirrors the fire-and-forget pattern of notifyOwnerOnPayment (in-process,
// best-effort, never throws to caller).
//
// TODO (template): when the Meta "velora_tracking_update" template is ACTIVE
// in Meta Business Manager, replace the free-text sendWhatsAppMessage call
// below with a template send (sendWhatsAppTemplate) so message delivery is
// guaranteed even outside the 24-hour conversation window.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { isAndreaniMockTracking } from "@/app/api/agents/andreani/_lib/andreani-mock";

export interface SendCustomerTrackingWppParams {
  paymentIntentId: string;
  businessId: string;
  customerPhone: string | null;
}

/**
 * Sends an Andreani tracking WhatsApp message to the customer.
 * Resolves the tracking number from the AndreaniShipment row created for the
 * given paymentIntentId. Best-effort — never throws; all failures are logged.
 */
export async function sendCustomerTrackingWpp({
  paymentIntentId,
  businessId,
  customerPhone,
}: SendCustomerTrackingWppParams): Promise<void> {
  // Resolve tracking number from the shipment just created.
  // findFirst with composite { saleId, businessId } guard enforces tenant
  // isolation — saleId alone is a unique index but carries no tenant context.
  // Multi-tenant SaaS 2026 pattern: every cross-tenant-leakable query must
  // include a tenancy column in the where clause (cf. Prisma multi-tenant docs).
  const shipment = await prisma.andreaniShipment.findFirst({
    where: { saleId: paymentIntentId, businessId },
    select: { trackingNumber: true },
  });

  if (!shipment?.trackingNumber) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "TRACKING_WPP_NO_SHIPMENT",
      a2a_transfer: false,
      message: "No AndreaniShipment found after create — skipping tracking WPP",
      data: { paymentIntentId },
      businessId,
    });
    return;
  }

  if (!customerPhone) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "TRACKING_WPP_NO_PHONE",
      a2a_transfer: false,
      message: "No customer phone — skipping tracking WPP",
      data: { paymentIntentId },
      businessId,
    });
    return;
  }

  const tn = shipment.trackingNumber;
  // Mock tracking numbers (ARK- prefix) do not resolve on andreani.com — show
  // a "(simulación)" label instead of a broken URL so the customer isn't confused.
  const trackingDetail = isAndreaniMockTracking(tn)
    ? `Nro. de seguimiento: ${tn} (simulación)`
    : `Podés ver el estado en https://www.andreani.com/seguimiento/${tn}`;
  const msg = `Tu envío salió 📦. Seguimiento Andreani: ${tn}. ${trackingDetail}`;

  try {
    await sendWhatsAppMessage(customerPhone, msg, undefined, businessId);
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "TRACKING_WPP_SENT",
      a2a_transfer: false,
      message: `Tracking WPP sent to customer for shipment ${tn}`,
      data: { paymentIntentId, trackingNumber: tn, phone: `...${customerPhone.slice(-4)}` },
      businessId,
    });
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "TRACKING_WPP_FAILED",
      a2a_transfer: false,
      message: `Tracking WPP send failed (non-blocking): ${err instanceof Error ? err.message : String(err)}`,
      data: { paymentIntentId, trackingNumber: tn },
      businessId,
    });
  }
}
