import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { logRouteError, verifyCronSecret } from "@/app/api/_lib/route-helpers";
import {
  cleanA2aJtiSeen,
  cleanAgentEventLog,
  cleanAiRateLimit,
  cleanCashMovement,
  cleanChatMessage,
  cleanCriticalWriteEvent,
  cleanIdempotencyRecord,
  cleanOAuthState,
  cleanPaymentIntents,
  cleanPushSubscriptions,
  cleanRateLimitBuckets,
  cleanReconcileFastTrackOrphans,
  cleanSessions,
  cleanStockMovement,
  cleanStuckPendingIdempotencyRecords,
  cleanWebhookSecurityIncidents,
} from "./_lib/audit-cleanup";

export const maxDuration = 300;

/**
 * Canonical cleanup cron — daily at 04:00 UTC (01:00 ART).
 *
 * Single source of truth for all table-level TTL retention. Individual
 * cron/cleanup-* routes are kept as no-ops (CRON_CLEANUP_DEPRECATED) until
 * the Cloud Scheduler jobs pointing at them are decommissioned.
 *
 * TTL policy (consolidated 2026-05-13 — all prior per-table crons merged here):
 *   CriticalWriteEvent   → 90d  (unified audit trail — absorbed AuditLog 2026-05-16)
 *   AgentEventLog        → 180d
 *   StockMovement        → 365d
 *   CashMovement         → 365d
 *   ChatMessage          → 90d
 *   IdempotencyRecord    → 48h
 *   Session              → expired (NextAuth field)
 *   PaymentIntent        → pending past expiresAt → "expired"
 *   PushSubscription     → expired=true OR updatedAt > 30d ago
 *   OAuthState           → expiresAt < now (abandoned OAuth flows)
 *   AiRateLimit          → date > 30d ago (per-user daily counters)
 *   PaymentIntent (reconcile orphan) → reconcileFastTrack reset on terminal PIs, cap 1000
 *
 * Sequential deletes — avoid saturating Supabase with parallel large DELETEs.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

// GET kept for manual/curl verification; POST is the canonical Cloud Scheduler verb.
export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "audit-cleanup");
  if (unauth) return unauth;

  // REG-T4-1: SET LOCAL is now issued inside each batchedDelete $transaction
  // (see audit-cleanup.ts). A bare SET LOCAL here was silently dropped by
  // Supabase pgbouncer transaction mode. Removed to avoid confusion.

  const startedAt = Date.now();
  const cutoff90 = new Date(startedAt - 90 * DAY_MS);
  const cutoff180 = new Date(startedAt - 180 * DAY_MS);
  const cutoff365 = new Date(startedAt - 365 * DAY_MS);

  try {
    const criticalWriteDeleted = await cleanCriticalWriteEvent(cutoff90);
    const agentEventLogDeleted = await cleanAgentEventLog(cutoff180);
    const stockMovementDeleted = await cleanStockMovement(cutoff365);
    const cashMovementDeleted = await cleanCashMovement(cutoff365);
    const chatMessageDeleted = await cleanChatMessage(cutoff90);
    const idempotencyRecordDeleted = await cleanIdempotencyRecord(startedAt);
    // Stuck-pending idempotency rows (> 5 min) — moved from per-request fire-and-forget
    // in beginIdempotentMutation to here to avoid per-call DB overhead under traffic.
    const stuckPendingIdempotencyDeleted = await cleanStuckPendingIdempotencyRecords(startedAt);
    const sessionsDeleted = await cleanSessions();
    const paymentIntentsExpired = await cleanPaymentIntents();
    const pushSubscriptionsDeleted = await cleanPushSubscriptions(startedAt);
    const rateLimitBucketsDeleted = await cleanRateLimitBuckets(startedAt);
    const a2aJtiDeleted = await cleanA2aJtiSeen();
    const oauthStateDeleted = await cleanOAuthState();
    const aiRateLimitDeleted = await cleanAiRateLimit(startedAt);
    const webhookSecurityIncidentsDeleted = await cleanWebhookSecurityIncidents();
    const reconcileFastTrackOrphansReset = await cleanReconcileFastTrackOrphans();

    const durationMs = Date.now() - startedAt;

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "AUDIT_CLEANUP_COMPLETED",
      a2a_transfer: false,
      message: "Audit cleanup completed",
      businessId: "",
      data: {
        event: "AUDIT_CLEANUP_COMPLETED",
        durationMs,
        criticalWriteDeleted,
        agentEventLogDeleted,
        stockMovementDeleted,
        cashMovementDeleted,
        chatMessageDeleted,
        idempotencyRecordDeleted,
        stuckPendingIdempotencyDeleted,
        sessionsDeleted,
        paymentIntentsExpired,
        pushSubscriptionsDeleted,
        rateLimitBucketsDeleted,
        a2aJtiDeleted,
        oauthStateDeleted,
        aiRateLimitDeleted,
        webhookSecurityIncidentsDeleted,
        reconcileFastTrackOrphansReset,
        cutoff90: cutoff90.toISOString(),
        cutoff180: cutoff180.toISOString(),
        cutoff365: cutoff365.toISOString(),
      },
    });

    return NextResponse.json({
      ok: true,
      durationMs,
      criticalWriteDeleted,
      agentEventLogDeleted,
      stockMovementDeleted,
      cashMovementDeleted,
      chatMessageDeleted,
      idempotencyRecordDeleted,
      stuckPendingIdempotencyDeleted,
      sessionsDeleted,
      paymentIntentsExpired,
      pushSubscriptionsDeleted,
      rateLimitBucketsDeleted,
      a2aJtiDeleted,
      oauthStateDeleted,
      aiRateLimitDeleted,
      webhookSecurityIncidentsDeleted,
      reconcileFastTrackOrphansReset,
      cutoff90: cutoff90.toISOString(),
      cutoff180: cutoff180.toISOString(),
      cutoff365: cutoff365.toISOString(),
    });
  } catch (error) {
    logRouteError("scheduled/audit-cleanup", error);
    return NextResponse.json({ error: "cleanup failed" }, { status: 500 });
  }
}
