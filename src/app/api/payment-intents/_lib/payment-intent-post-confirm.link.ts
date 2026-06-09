// Link-payment post-confirm helpers (Camino B: checkout_pro_link).
// Extracted from payment-intent-post-confirm.ts to keep the main file under 300 lines.

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { triggerFiscalReceipt } from "./trigger-fiscal-receipt";
import { triggerShipmentCreate } from "./trigger-shipment-create";
import { notifyOwnerOnPayment } from "./notify-owner-on-payment";
import { publishPostCommitFailure } from "@/app/api/_lib/post-commit-failure-publisher";
import { claimAndSendTrackingWpp } from "./payment-intent-tracking-wpp";
import {
  writeHopProcessing,
  writeHopComprobanteSent,
  writeHopComprobanteFailed,
  writeHopShipmentCreated,
  writeHopShipmentFailed,
  writeHopTrackingSent,
  writeHopTrackingFailed,
  markHopProcessingResolved,
} from "./payment-intent-post-confirm.hop-chat";

export async function runLinkPaymentPostConfirm(
  intent: {
    id: string;
    businessId: string;
    saleId: string | null;
    comprobanteSentAt: Date | null;
    shippingRequired: boolean;
    shipmentCreatedAt: Date | null;
    trackingWppSentAt: Date | null;
    matchedCustomerId: string | null;
    shippingAddress: unknown;
  },
): Promise<void> {
  const postConfirmRunId = randomUUID(); // Finding #6: GCL trace correlation

  // ── Paso 0: avisar al dueño que entró el pago ─────────────────────────────
  // El cliente no avisa nada — Velora detecta el pago y notifica al dueño solo
  // (ChatMessage owner_only + push). Best-effort e idempotente.
  await notifyOwnerOnPayment(intent.id, intent.businessId);

  // One DB read shared by all hop writers (findFirst+businessId: tenant guard).
  let customerName: string | null = null;
  if (intent.matchedCustomerId) {
    const c = await prisma.customer.findFirst({
      where: { id: intent.matchedCustomerId, businessId: intent.businessId },
      select: { name: true },
    }).catch(() => null);
    customerName = c?.name ?? null;
  }

  // Enqueue ack: idempotent per-step observable (Vercel AI SDK 6 / Stripe 2026).
  void writeHopProcessing(intent.businessId, intent.id);

  // ── Paso 1: Comprobante — atomic claim-first (brandur.org/idempotency-keys §atomic-phases) ──
  const comprobanteClaimTime = new Date();
  const comprobanteClaim = await prisma.paymentIntent.updateMany({
    where: { id: intent.id, comprobanteSentAt: null },
    data: { comprobanteSentAt: comprobanteClaimTime },
  });

  if (comprobanteClaim.count === 0) {
    // Another concurrent execution already claimed the stamp — skip the fiscal receipt work.
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "COMPROBANTE_ALREADY_CLAIMED",
      a2a_transfer: false,
      message: "runLinkPaymentPostConfirm: lost atomic claim — concurrent runner already stamped comprobanteSentAt, skipping duplicate fiscal receipt",
      data: { paymentIntentId: intent.id },
      businessId: intent.businessId,
    });
    // Emit success hop if prior run already won the race. P2002 collapses duplicates.
    if (intent.comprobanteSentAt !== null) {
      void writeHopComprobanteSent(intent.businessId, intent.id, customerName);
      void markHopProcessingResolved(intent.businessId, intent.id); // cosmetic, best-effort
    }
  } else {
    try {
      const result = await triggerFiscalReceipt(intent.id, postConfirmRunId, intent.businessId);
      if (result.ok) {
        cloudLog({
          severity: "INFO",
          component: "System",
          action: "COMPROBANTE_SENT_AT_STAMPED",
          a2a_transfer: false,
          message: "comprobanteSentAt already claimed atomically; fiscal receipt send succeeded",
          data: { paymentIntentId: intent.id },
          businessId: intent.businessId,
        });
        // Hop 1 OK — per-step chat write (Vercel AI SDK 6 tool-span pattern 2026).
        void writeHopComprobanteSent(intent.businessId, intent.id, customerName);
        void markHopProcessingResolved(intent.businessId, intent.id); // clear ⏳ bubble
      } else {
        // Transient failure from fiscal agent: roll back the claim so the retry
        // cron can re-enter. Scoped to comprobanteClaimTime to avoid clobbering
        // a concurrent winner that stamped a different timestamp.
        await prisma.paymentIntent.updateMany({
          where: { id: intent.id, comprobanteSentAt: comprobanteClaimTime },
          data: { comprobanteSentAt: null },
        });
        const reason = result.reason;
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "COMPROBANTE_SEND_FAILED",
          a2a_transfer: false,
          message: `triggerFiscalReceipt returned !ok: ${reason}`,
          data: { paymentIntentId: intent.id, reason },
          businessId: intent.businessId,
        });
        // Hop 1 FAIL — owner sees the failure + ⏳ clears (no stuck "Procesando").
        void writeHopComprobanteFailed(intent.businessId, intent.id, customerName, reason);
        void markHopProcessingResolved(intent.businessId, intent.id);
        // C-2: post-commit-replay.ts retries triggerFiscalReceipt with exponential backoff.
        await publishPostCommitFailure({
          businessId: intent.businessId,
          saleId: intent.saleId,
          action: "COMPROBANTE_SEND_FAILED",
          errorMessage: reason,
          originalArgs: { paymentIntentId: intent.id },
        });
      }
    } catch (err) {
      // Transient exception: roll back the claim (scoped to claimTime) so the
      // retry cron can re-enter. Keep the stamp on permanent failures only when
      // we know retrying would not help — exception path is always transient.
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, comprobanteSentAt: comprobanteClaimTime },
        data: { comprobanteSentAt: null },
      });
      const errMsg = err instanceof Error ? err.message : String(err);
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "COMPROBANTE_SEND_EXCEPTION",
        a2a_transfer: false,
        message: `Unexpected error in triggerFiscalReceipt: ${errMsg}`,
        data: { paymentIntentId: intent.id },
        businessId: intent.businessId,
      });
      // Hop 1 EXCEPTION — owner sees it in chat.
      void writeHopComprobanteFailed(intent.businessId, intent.id, customerName, errMsg);
      void markHopProcessingResolved(intent.businessId, intent.id); // clear ⏳ even on exception
      await publishPostCommitFailure({
        businessId: intent.businessId,
        saleId: intent.saleId,
        action: "COMPROBANTE_SEND_FAILED",
        errorMessage: errMsg,
        originalArgs: { paymentIntentId: intent.id },
      });
    }
  }

  // ── Paso 2: Envío Andreani ────────────────────────────────────────────────
  if (intent.shippingRequired && !intent.shipmentCreatedAt) {
    await runShipmentChain(intent, customerName);
  }
}

// ── Shared shipment+tracking chain (caller owns idempotency gate) ────────────

export async function runShipmentChain(
  intent: {
    id: string;
    businessId: string;
    saleId: string | null;
    shipmentCreatedAt: Date | null;
    trackingWppSentAt: Date | null;
    matchedCustomerId: string | null;
    shippingAddress: unknown;
  },
  customerName?: string | null,
): Promise<void> {
  const now = new Date();

  // PI-level atomic claim: stamp shipmentCreatedAt NOW as a mutex.
  // This covers saleId=null paths (no Sale to stamp) AND adds defense-in-depth
  // for saleId!=null paths. Concurrent retries that arrive here will find
  // count===0 and bail out without calling Andreani twice.
  const piClaim = await prisma.paymentIntent.updateMany({
    where: { id: intent.id, shipmentCreatedAt: null },
    data: { shipmentCreatedAt: now },
  });
  if (piClaim.count === 0) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SHIPMENT_ALREADY_CLAIMED",
      a2a_transfer: false,
      message: "runShipmentChain skipped — shipmentCreatedAt already claimed by concurrent run",
      data: { paymentIntentId: intent.id, saleId: intent.saleId },
      businessId: intent.businessId,
    });
    return;
  }

  // C-1 idempotency guard: if a real Sale exists for this intent, atomically
  // stamp Sale.logisticaTriggeredAt before calling Andreani.
  if (intent.saleId) {
    const stamped = await prisma.sale.updateMany({
      where: { id: intent.saleId, businessId: intent.businessId, logisticaTriggeredAt: null },
      data: { logisticaTriggeredAt: new Date() },
    });
    if (stamped.count === 0) {
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "SHIPMENT_CREATE_LOGISTICA_ALREADY_FIRED",
        a2a_transfer: false,
        message: "Shipment create skipped — logisticaTriggeredAt already stamped by sale-post-commit (dedup)",
        data: { paymentIntentId: intent.id, saleId: intent.saleId },
        businessId: intent.businessId,
      });
      return;
    }
  }

  try {
    const result = await triggerShipmentCreate(intent.id, intent.businessId);
    if (result.ok) {
      // shipmentCreatedAt was already stamped by the PI-level claim at entry.
      cloudLog({
        severity: "INFO",
        component: "System",
        action: "SHIPMENT_CREATED_AT_STAMPED",
        a2a_transfer: false,
        message: "shipmentCreatedAt already stamped via atomic claim; shipment.create succeeded",
        data: { paymentIntentId: intent.id, agentText: result.agentText.slice(0, 200) },
        businessId: intent.businessId,
      });
      // Hop 2 OK — owner sees shipment line in chat (LangGraph step-boundary pattern 2026).
      void writeHopShipmentCreated(intent.businessId, intent.id, result.agentText);

      // WPP tracking al cliente — atomic claim + send delegated to sibling helper.
      // Idempotency stamp (trackingWppSentAt) lives inside claimAndSendTrackingWpp;
      // concurrent retries and cron replay both lose the race gracefully.
      try {
        await claimAndSendTrackingWpp(intent);
        // Hop 3 OK — owner sees tracking confirmation in chat.
        void writeHopTrackingSent(intent.businessId, intent.id, customerName ?? null);
      } catch (trackErr) {
        const trackErrMsg = trackErr instanceof Error ? trackErr.message : String(trackErr);
        // Hop 3 FAIL — tracking WPP failed; owner sees it in chat (best-effort).
        void writeHopTrackingFailed(intent.businessId, intent.id, customerName ?? null, trackErrMsg);
      }
    } else {
      // Roll back the PI-level claim so the retry cron can re-enter.
      await prisma.paymentIntent.updateMany({
        where: { id: intent.id, shipmentCreatedAt: now },
        data: { shipmentCreatedAt: null },
      });
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "SHIPMENT_CREATE_FAILED_POST_CONFIRM",
        a2a_transfer: false,
        message: `triggerShipmentCreate returned !ok: ${result.reason}`,
        data: { paymentIntentId: intent.id, reason: result.reason },
        businessId: intent.businessId,
      });
      // Hop 2 FAIL — owner sees the failure in chat (Stripe event timeline pattern 2026).
      void writeHopShipmentFailed(intent.businessId, intent.id, result.reason);
      // C-1 FIX: publish to event-retry cron.
      await publishPostCommitFailure({
        businessId: intent.businessId,
        saleId: intent.saleId,
        action: "SHIPMENT_CREATE_FAILED",
        errorMessage: result.reason,
        originalArgs: { paymentIntentId: intent.id },
      });
    }
  } catch (err) {
    // Roll back the PI-level claim so the retry cron can re-enter.
    await prisma.paymentIntent.updateMany({
      where: { id: intent.id, shipmentCreatedAt: now },
      data: { shipmentCreatedAt: null },
    });
    const errMsg = err instanceof Error ? err.message : String(err);
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "SHIPMENT_CREATE_EXCEPTION",
      a2a_transfer: false,
      message: `Unexpected error in triggerShipmentCreate: ${errMsg}`,
      data: { paymentIntentId: intent.id },
      businessId: intent.businessId,
    });
    // Hop 2 EXCEPTION — owner sees it in chat.
    void writeHopShipmentFailed(intent.businessId, intent.id, errMsg);
    await publishPostCommitFailure({
      businessId: intent.businessId,
      saleId: intent.saleId,
      action: "SHIPMENT_CREATE_FAILED",
      errorMessage: errMsg,
      originalArgs: { paymentIntentId: intent.id },
    });
  }
}
