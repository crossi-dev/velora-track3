// Payment-related post-commit replay handlers.
// Extracted from post-commit-replay.ts to keep the dispatch table file under 300 lines.

import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { claimAndSendTrackingWpp } from "@/app/api/payment-intents/_lib/payment-intent-tracking-wpp";
import type { ReplayResult } from "./post-commit-replay";

export async function replayComprobanteSend(
  businessId: string,
  originalArgs: Record<string, unknown> | undefined,
): Promise<ReplayResult> {
  const paymentIntentId =
    typeof originalArgs?.["paymentIntentId"] === "string" ? originalArgs["paymentIntentId"] : null;
  if (!paymentIntentId) {
    return { status: "skipped", reason: "missing paymentIntentId in originalArgs" };
  }

  // Idempotency: if comprobanteSentAt is already stamped, the comprobante went
  // through (possibly via a concurrent confirm or a prior cron run). Skip.
  //
  // RLS-verify audit: findFirst with compound where — OWASP secure-by-default tenant isolation.
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: paymentIntentId, businessId },
    select: { comprobanteSentAt: true, businessId: true },
  });
  if (!intent || intent.businessId !== businessId) {
    return { status: "skipped", reason: "intent not found" };
  }
  if (intent.comprobanteSentAt !== null) {
    return { status: "skipped", reason: "comprobanteSentAt already stamped" };
  }

  try {
    const { triggerFiscalReceipt } = await import(
      "@/app/api/payment-intents/_lib/trigger-fiscal-receipt"
    );
    // JD Fix #5: pass a fresh replayRunId so cron-retry fiscal logs are traceable
    // in GCL. This is a NEW run (not a continuation), so we generate a fresh UUID
    // rather than recovering the original postConfirmRunId (which would require
    // reading it from AgentEventLog.originalArgs — more complex, less benefit).
    const replayRunId = randomUUID();
    const result = await triggerFiscalReceipt(paymentIntentId, replayRunId, businessId);
    if (!result.ok) {
      return { status: "failed", error: `triggerFiscalReceipt !ok: ${result.reason}` };
    }
    // Stamp comprobanteSentAt so subsequent cron runs skip this intent.
    await prisma.paymentIntent.update({
      where: { id: paymentIntentId },
      data: { comprobanteSentAt: new Date() },
    });
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "COMPROBANTE_REPLAY_STAMPED",
      a2a_transfer: false,
      message: "replayComprobanteSend: comprobanteSentAt stamped after successful replay",
      data: { paymentIntentId },
      businessId,
    });
    return { status: "replayed" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function replayShipmentCreate(
  businessId: string,
  originalArgs: Record<string, unknown> | undefined,
): Promise<ReplayResult> {
  const paymentIntentId =
    typeof originalArgs?.["paymentIntentId"] === "string" ? originalArgs["paymentIntentId"] : null;
  if (!paymentIntentId) {
    return { status: "skipped", reason: "missing paymentIntentId in originalArgs" };
  }

  // Idempotency: if shipmentCreatedAt is already stamped, the shipment was created
  // (possibly by a concurrent run or a prior cron). Skip.
  //
  // RLS-verify audit: findFirst with compound where — OWASP secure-by-default tenant isolation.
  const intent = await prisma.paymentIntent.findFirst({
    where: { id: paymentIntentId, businessId },
    select: {
      shipmentCreatedAt: true,
      trackingWppSentAt: true,
      businessId: true,
      shippingRequired: true,
      shippingAddress: true,
      matchedCustomerId: true,
    },
  });
  if (!intent || intent.businessId !== businessId) {
    return { status: "skipped", reason: "intent not found" };
  }
  if (intent.shipmentCreatedAt !== null) {
    return { status: "skipped", reason: "shipmentCreatedAt already stamped" };
  }
  if (!intent.shippingRequired) {
    return { status: "skipped", reason: "shippingRequired is false — no shipment needed" };
  }

  try {
    const { triggerShipmentCreate } = await import(
      "@/app/api/payment-intents/_lib/trigger-shipment-create"
    );
    const result = await triggerShipmentCreate(paymentIntentId, businessId);
    if (!result.ok) {
      return { status: "failed", error: `triggerShipmentCreate !ok: ${result.reason}` };
    }
    // Stamp shipmentCreatedAt so subsequent cron runs skip this intent.
    await prisma.paymentIntent.update({
      where: { id: paymentIntentId },
      data: { shipmentCreatedAt: new Date() },
    });
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SHIPMENT_REPLAY_STAMPED",
      a2a_transfer: false,
      message: "replayShipmentCreate: shipmentCreatedAt stamped after successful replay",
      data: { paymentIntentId },
      businessId,
    });

    // Fan-out: send tracking WPP to customer via shared atomic-claim helper.
    // Idempotency stamp (trackingWppSentAt) is owned by claimAndSendTrackingWpp;
    // concurrent webhook retries and cron replays both lose the race gracefully.
    await claimAndSendTrackingWpp({
      id: paymentIntentId,
      businessId,
      matchedCustomerId: intent.matchedCustomerId,
      shippingAddress: intent.shippingAddress,
    });

    return { status: "replayed" };
  } catch (err) {
    return { status: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}
