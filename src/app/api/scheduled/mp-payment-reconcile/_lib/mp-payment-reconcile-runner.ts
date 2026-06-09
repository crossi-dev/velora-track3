// MP payment reconciliation cron runner — C-1 + Fix-9 + 2026 threshold + inline-DLQ.
//
// Missed-webhook recovery (Stripe process-undelivered-events pattern):
//   https://docs.stripe.com/webhooks/process-undelivered-events
// Fix-9: expired PIs included — MP can approve after merchant-side expiresAt.
// Staleness threshold: ≤5 min (B2C 2026 standard). Cron: 1 min. Worst-case: 6 min.
// Fast-track: reconcileFastTrack=true set by webhook handler on exception; cleared
//   on successful confirm. This file never writes reconcileFastTrack=true.
// Inline-DLQ: reconcileFailureCount increments on each failed confirm. At
//   STUCK_THRESHOLD (5) a CRITICAL log fires for ops intervention.
//   Ref: https://sreschool.com/blog/dead-letter-queue-dlq/ (inline-DLQ 2026)
//
// OPTION A — Reconcile enqueues to Cloud Tasks worker (not inline confirm+side-effects).
// Single execution point: confirm + side-effects always run in the worker, regardless
// of trigger (webhook OR reconcile). Idempotency via shared task name "mp-confirm-{piId}".
// Refs: https://cloud.google.com/tasks/docs/dual-overview#task_queues_as_a_recovery_mechanism
//       https://microservices.io/patterns/data/transactional-outbox.html
//       https://docs.stripe.com/webhooks/process-undelivered-events

import pLimit from "p-limit";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { getValidAccessToken } from "@/app/api/integrations/mp/_lib/refresh-token";
import { getMpPaymentStatusByPreference } from "@/app/api/agents/payments/jsonrpc/_lib/mp-status-helpers";
import { handleNonApprovedStatus } from "./mp-payment-reconcile-non-approved";
import { enqueuePaymentConfirm } from "@/lib/cloud-tasks-enqueue";
// Raw MP status Sets are no longer used here — getMpPaymentStatusByPreference
// now returns VeloraPaymentStatus directly. Comparisons are against canonical
// Velora values ("approved", "pending", "rejected", "refunded", "disputed").

// 2026 industry standard: staleness threshold ≤ 5 min for B2C payment recovery.
// Cron cadence: 1 min. Worst-case recovery window: 6 min.
// Ref: https://docs.stripe.com/webhooks/process-undelivered-events (process-undelivered-events pattern)
// Prior value was 30 min (30-min worst-case gap — anti-pattern for real-time B2C).
const STALE_THRESHOLD_MS = 5 * 60 * 1000;

// Process at most 100 stale intents per run. Bumped from 50 → 100 because the
// query now includes expired PIs (Fix-9), growing the candidate universe with
// historical rows. Cloud Run CPU budget is still bounded: 100 × CONCURRENCY=5
// means at most 20 sequential MP API round-trips per run.
const BATCH_LIMIT = 100;

// 5 concurrent MP API calls — matches mp-health-check-runner.ts CONCURRENCY.
const CONCURRENCY = 5;

// Inline-DLQ: CRITICAL log fires when reconcileFailureCount >= STUCK_THRESHOLD.
// At 1-min cron cadence = 5 min of consecutive failures before alerting ops.
const STUCK_THRESHOLD = 5;

export interface ReconcileResult {
  checked: number;
  confirmed: number;
  skipped: number;
  failed: number;
  fastTracked: number;
  stuck: number;
}

export async function runMpPaymentReconcile(): Promise<ReconcileResult> {
  const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);

  // Query: stale (pending|expired) PIs + any fast-tracked by the webhook handler.
  // providerRef: { not: null } skips orphan PIs (no MP preference was created).
  const staleIntents = await prisma.paymentIntent.findMany({
    where: {
      metodo: "checkout_pro_link",
      estado: { in: ["pending", "expired"] },
      providerRef: { not: null },
      OR: [
        { createdAt: { lt: staleThreshold } },
        { reconcileFastTrack: true },
      ],
    },
    select: {
      id: true,
      businessId: true,
      providerRef: true,
      monto: true,
      createdAt: true,
      reconcileFastTrack: true,
      reconcileFailureCount: true,
    },
    orderBy: { createdAt: "asc" },
    take: BATCH_LIMIT,
  });

  let confirmed = 0;
  let skipped = 0;
  let failed = 0;
  let fastTracked = 0;
  let stuck = 0;

  const limit = pLimit(CONCURRENCY);

  await Promise.all(
    staleIntents.map((intent) =>
      limit(async () => {
        const {
          id: paymentIntentId,
          businessId,
          providerRef,
          monto,
          createdAt,
          reconcileFastTrack,
          reconcileFailureCount,
        } = intent;
        const ageMs = Date.now() - createdAt.getTime();

        if (reconcileFastTrack) {
          fastTracked++;
          cloudLog({
            severity: "INFO",
            component: "System",
            action: "MP_RECONCILE_FAST_TRACK_PICKUP",
            a2a_transfer: false,
            message: "reconcile: fast-track PI picked up (webhook handler exception flagged this intent)",
            data: { paymentIntentId, ageMs, reconcileFailureCount },
            businessId,
          });
          if (reconcileFailureCount >= STUCK_THRESHOLD) {
            stuck++;
            cloudLog({
              severity: "CRITICAL",
              component: "System",
              action: "MP_RECONCILE_STUCK_FAST_TRACK",
              a2a_transfer: false,
              message: `reconcile: PI stuck after ${reconcileFailureCount} consecutive confirm failures — manual intervention required`,
              data: {
                paymentIntentId,
                reconcileFailureCount,
                ageMs,
                amountARS: monto,
              },
              businessId,
            });
          }
        }

        // No providerRef → orphan PI (agent crash before adapter wrote it).
        if (!providerRef) {
          cloudLog({
            severity: "INFO",
            component: "System",
            action: "MP_RECONCILE_SKIP_NO_PROVIDER_REF",
            a2a_transfer: false,
            message: "reconcile: skipping intent without providerRef — orphan-heal path applies",
            data: { paymentIntentId },
            businessId,
          });
          skipped++;
          return;
        }

        const accessToken = await getValidAccessToken(businessId);
        if (!accessToken) {
          cloudLog({
            severity: "WARNING",
            component: "System",
            action: "MP_RECONCILE_NO_TOKEN",
            a2a_transfer: false,
            message: "reconcile: could not obtain MP access token — skipping intent",
            data: { paymentIntentId, preferenceId: providerRef },
            businessId,
          });
          skipped++;
          return;
        }

        const mpResult = await getMpPaymentStatusByPreference({
          accessToken,
          businessId,
          paymentIntentId,
        });
        // providerRef (preferenceId) retained in logs for traceability only.
        void providerRef;

        // ── MP payment status check ───────────────────────────────────────────
        // mpResult.status is already a VeloraPaymentStatus (mapped at the helper).
        // "approved" is the only status that triggers confirmation; all others skip.

        if (mpResult.status !== "approved") {
          await handleNonApprovedStatus({
            paymentIntentId,
            businessId,
            providerRef,
            mpStatus: mpResult.status,
          });
          skipped++;
          return;
        }

        // Option A: enqueue to Cloud Tasks worker. Worker runs confirm + side effects.
        // Task name shared with webhook → Cloud Tasks deduplicates within 1-hour window.
        try {
          await enqueuePaymentConfirm({ paymentIntentId, businessId });
          confirmed++;
          cloudLog({
            severity: "INFO",
            component: "System",
            action: "MP_RECONCILE_ENQUEUED",
            a2a_transfer: false,
            message: "reconcile: approved PI enqueued to velora-payment-confirm worker",
            data: { paymentIntentId, preferenceId: providerRef, wasFastTracked: reconcileFastTrack },
            businessId,
          });
          // Clear fast-track flag + DLQ counters on successful enqueue.
          // If the task was already deduped by Cloud Tasks (task already exists),
          // the enqueue throws ALREADY_EXISTS — caught below, treated as skipped.
          await prisma.paymentIntent.update({
            where: { id: paymentIntentId },
            data: {
              reconcileFastTrack: false,
              reconcileFailureCount: 0,
              reconcileLastError: null,
            },
          });
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          // ALREADY_EXISTS means Cloud Tasks already has a live task for this PI
          // (webhook beat us to the enqueue). Count as skipped — the worker will run.
          // ALREADY_EXISTS can no longer fire (task names auto-generated) but
          // keep the branch for backward-compat if any in-flight legacy task remains.
          if (errorMsg.includes("ALREADY_EXISTS") || errorMsg.includes("already exists")) {
            skipped++;
            cloudLog({
              severity: "INFO",
              component: "System",
              action: "MP_RECONCILE_TASK_ALREADY_EXISTS",
              a2a_transfer: false,
              message: "reconcile: task already enqueued by webhook handler — skipping duplicate",
              data: { paymentIntentId },
              businessId,
            });
            return;
          }
          failed++;
          cloudLog({
            severity: "ERROR",
            component: "System",
            action: "MP_RECONCILE_ENQUEUE_FAILED",
            a2a_transfer: false,
            message: `reconcile: enqueuePaymentConfirm threw: ${errorMsg}`,
            data: { paymentIntentId, preferenceId: providerRef },
            businessId,
          });
          // DLQ increment: reconcileFastTrack stays true → next tick retries.
          await prisma.paymentIntent.update({
            where: { id: paymentIntentId },
            data: {
              reconcileFailureCount: { increment: 1 },
              reconcileLastError: errorMsg.slice(0, 500),
            },
          });
        }
      }),
    ),
  );

  const result: ReconcileResult = { checked: staleIntents.length, confirmed, skipped, failed, fastTracked, stuck };

  // Structured run summary — makes each cron execution queryable in Cloud Logging.
  // `stuck` field feeds the reconcile-fast-track-depth Cloud Monitoring alert.
  cloudLog({
    severity: "INFO",
    component: "System",
    action: "MP_RECONCILE_RUN",
    a2a_transfer: false,
    message: `MP reconcile run complete: inspected=${result.checked} confirmed=${result.confirmed} skipped=${result.skipped} errors=${result.failed} fastTracked=${result.fastTracked} stuck=${result.stuck}`,
    data: result as unknown as Record<string, unknown>,
  });

  return result;
}
