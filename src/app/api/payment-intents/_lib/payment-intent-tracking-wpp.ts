// Atomic tracking-WPP send with idempotency stamp.
// Extracted from payment-intent-post-confirm.link.ts to keep that file under 300 lines.
//
// Pattern: updateMany WHERE trackingWppSentAt IS NULL as the atomic mutex.
// count===0 → another runner already claimed → skip (at-most-once delivery).
// On exception → roll back the stamp so the cron replay can re-enter.
// Mirrors comprobanteSentAt / shipmentCreatedAt patterns throughout the codebase.
//
// Ref: Stripe idempotency-keys §atomic-phases, Shopify InventoryShipmentReceive
// idempotent mutations (2026), Hookdeck deduplication persistent-store guide 2026.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendCustomerTrackingWpp } from "@/app/api/agents/communications/jsonrpc/_lib/send-customer-tracking-wpp";
import { publishPostCommitFailure } from "@/app/api/_lib/post-commit-failure-publisher";

export async function claimAndSendTrackingWpp(intent: {
  id: string;
  businessId: string;
  matchedCustomerId: string | null;
  shippingAddress: unknown;
}): Promise<void> {
  const trackingClaimTime = new Date();
  const trackingClaim = await prisma.paymentIntent.updateMany({
    where: { id: intent.id, trackingWppSentAt: null },
    data: { trackingWppSentAt: trackingClaimTime },
  });

  if (trackingClaim.count === 0) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "TRACKING_WPP_ALREADY_SENT",
      a2a_transfer: false,
      message: "claimAndSendTrackingWpp: trackingWppSentAt already stamped — skipping duplicate tracking WPP",
      data: { paymentIntentId: intent.id },
      businessId: intent.businessId,
    });
    return;
  }

  let customerPhone: string | null = null;
  const addrRaw = intent.shippingAddress;
  if (addrRaw && typeof addrRaw === "object" && !Array.isArray(addrRaw)) {
    const ph = (addrRaw as Record<string, unknown>).phone;
    if (typeof ph === "string" && ph.trim()) customerPhone = ph.trim();
  }
  // findFirst with businessId: defense-in-depth tenant guard on customer PII.
  if (!customerPhone && intent.matchedCustomerId) {
    const customer = await prisma.customer.findFirst({
      where: { id: intent.matchedCustomerId, businessId: intent.businessId },
      select: { phone: true },
    });
    customerPhone = customer?.phone ?? null;
  }

  try {
    await sendCustomerTrackingWpp({
      paymentIntentId: intent.id,
      businessId: intent.businessId,
      customerPhone,
    });
  } catch (trackingErr) {
    const trackingErrMsg = trackingErr instanceof Error ? trackingErr.message : String(trackingErr);
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "TRACKING_WPP_SEND_EXCEPTION",
      a2a_transfer: false,
      message: `claimAndSendTrackingWpp: unexpected error in sendCustomerTrackingWpp: ${trackingErrMsg}`,
      data: { paymentIntentId: intent.id },
      businessId: intent.businessId,
    });
    // Roll back the claim so the retry cron can re-enter.
    // If rollback fails (DB partition), log CRITICAL + dead-letter via publishPostCommitFailure.
    try {
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, trackingWppSentAt: trackingClaimTime },
        data: { trackingWppSentAt: null },
      });
    } catch (rollbackErr) {
      const rollbackMsg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      cloudLog({
        severity: "CRITICAL",
        component: "System",
        action: "TRACKING_WPP_ROLLBACK_FAILED",
        a2a_transfer: false,
        message: `claimAndSendTrackingWpp: rollback failed — trackingWppSentAt may be permanently stale: ${rollbackMsg}`,
        data: { paymentIntentId: intent.id },
        businessId: intent.businessId,
      });
      void publishPostCommitFailure({
        businessId: intent.businessId,
        saleId: null,
        action: "TRACKING_WPP_ROLLBACK_FAILED",
        errorMessage: rollbackMsg,
        originalArgs: { paymentIntentId: intent.id },
      });
    }
  }
}
