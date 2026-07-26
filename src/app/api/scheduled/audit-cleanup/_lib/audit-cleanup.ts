/**
 * audit-cleanup helpers — one function per table, each returning a count.
 *
 * All retention values are canonical. When a legacy cron/cleanup-* route
 * existed, the same retention is preserved here. New entries (ChatMessage,
 * IdempotencyRecord, Session, PaymentIntent, PushSubscription) are added per
 * the 2026-05-13 consolidation audit.
 *
 * TTL policy summary:
 *   CriticalWriteEvent   → 90 days   (unified audit trail — absorbed AuditLog 2026-05-16)
 *   AgentEventLog        → 180 days  (A2A diagnostic)
 *   StockMovement        → 365 days  (financial, 1-year minimum)
 *   CashMovement         → 365 days  (financial, 1-year minimum)
 *   ChatMessage          → 90 days   (matches legacy cron/cleanup-chat-messages)
 *   IdempotencyRecord    → 48 hours  (matches legacy cron/cleanup-idempotency)
 *   Session              → expired   (NextAuth; delete where expires < now)
 *   PaymentIntent        → expired   (pending rows past expiresAt → "expired")
 *   PushSubscription     → 30 days   (flagged by audit; expired=true or updatedAt old)
 *
 * High-volume tables (CriticalWriteEvent, AgentEventLog, ChatMessage) use a
 * batched DELETE loop: DELETE … WHERE id IN (SELECT id … LIMIT 1000). Each
 * batch is a separate short transaction — avoids holding a pgbouncer connection
 * for the duration of a 50k+ row delete on day 91+. Max 1 000 batches = 1 M
 * rows per cron run (sufficient ceiling given current retention windows).
 * Prisma deleteMany has no `take`, so $executeRawUnsafe is required for these three.
 */

import { prisma } from "@/lib/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1_000;
const MAX_BATCHES = 1_000;

// SEC-N-13: allowlist for batchedDelete — prevents table name injection if the
// caller is ever extended or called with dynamic input.
const ALLOWED_TABLES = new Set([
  "CriticalWriteEvent",
  "AgentEventLog",
  "StockMovement",
  "CashMovement",
  "ChatMessage",
  "A2aJtiSeen",
]);

/**
 * Delete rows older than `cutoff` from the given table in batches of BATCH_SIZE.
 * Uses raw SQL because Prisma deleteMany does not support LIMIT.
 * Returns the total number of rows deleted.
 *
 * REG-T4-1: each batch is wrapped in prisma.$transaction so that
 * SET LOCAL statement_timeout is honoured in Supabase pgbouncer transaction
 * mode. A bare SET LOCAL outside a transaction is silently dropped because
 * pgbouncer assigns a new backend connection for the next statement.
 * See prisma-tenant-extension.ts:14-20 for the canonical explanation.
 */
async function batchedDelete(
  table: string,
  cutoff: Date,
  extraWhere = "",
): Promise<number> {
  if (!ALLOWED_TABLES.has(table)) {
    throw new Error(`[audit-cleanup] batchedDelete: table "${table}" is not in the allowlist.`);
  }
  let total = 0;
  const clause = extraWhere ? `AND ${extraWhere}` : "";
  for (let i = 0; i < MAX_BATCHES; i++) {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '30000'");
      return tx.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE id IN (SELECT id FROM "${table}" WHERE "createdAt" < $1 ${clause} LIMIT ${BATCH_SIZE})`,
        cutoff,
      );
    });
    total += result;
    if (result < BATCH_SIZE) break; // last batch — nothing left
  }
  return total;
}

export async function cleanCriticalWriteEvent(cutoff90: Date): Promise<number> {
  return batchedDelete("CriticalWriteEvent", cutoff90);
}

export async function cleanAgentEventLog(cutoff180: Date): Promise<number> {
  return batchedDelete("AgentEventLog", cutoff180);
}

export async function cleanStockMovement(cutoff365: Date): Promise<number> {
  return batchedDelete("StockMovement", cutoff365);
}

export async function cleanCashMovement(cutoff365: Date): Promise<number> {
  return batchedDelete("CashMovement", cutoff365);
}

export async function cleanChatMessage(cutoff90: Date): Promise<number> {
  return batchedDelete("ChatMessage", cutoff90);
}

export async function cleanIdempotencyRecord(now: number): Promise<number> {
  const cutoff48h = new Date(now - 48 * 60 * 60 * 1000);
  // Exclude status="pending" rows: an in-flight mutation older than 48h is
  // pathological, but deleting its record while the handler still holds a
  // reference would let a racing retry bypass idempotency. The event-retry
  // cron marks stuck-pending rows as "error" first; cleanup runs after.
  const r = await prisma.idempotencyRecord.deleteMany({
    where: {
      createdAt: { lt: cutoff48h },
      status: { not: "pending" },
    },
  });
  return r.count;
}

export async function cleanSessions(): Promise<number> {
  const r = await prisma.session.deleteMany({
    where: { expires: { lt: new Date() } },
  });
  return r.count;
}

export async function cleanPaymentIntents(): Promise<number> {
  // C-2 FIX: exclude intents that already have a providerRef (MP took the charge).
  // A providerRef means MP has an active preference or payment for this intent —
  // the webhook may arrive late (up to 72h for MP retries). Marking it expired
  // while MP holds a confirmed payment would orphan the confirmation and lose money.
  // Rows without providerRef (QR in-store) expire normally on the 2-min window.
  const r = await prisma.paymentIntent.updateMany({
    where: {
      estado: "pending",
      expiresAt: { not: null, lt: new Date() },
      providerRef: null,
    },
    data: { estado: "expired" },
  });
  return r.count;
}

export async function cleanPushSubscriptions(now: number): Promise<number> {
  // Remove subscriptions explicitly marked expired OR not updated in 30 days.
  const cutoff30d = new Date(now - 30 * DAY_MS);
  const r = await prisma.pushSubscription.deleteMany({
    where: {
      OR: [
        { expired: true },
        { updatedAt: { lt: cutoff30d } },
      ],
    },
  });
  return r.count;
}

/**
 * Remove RateLimitBucket rows not updated in the last N days.
 * Inactive buckets (keys that haven't made a request) are safe to drop —
 * the next request will recreate the row with a fresh full bucket.
 * Default retention: 7 days.
 */
export async function cleanRateLimitBuckets(now: number, staleAfterDays = 7): Promise<number> {
  const cutoff = new Date(now - staleAfterDays * DAY_MS);
  const r = await prisma.rateLimitBucket.deleteMany({
    where: { updatedAt: { lt: cutoff } },
  });
  return r.count;
}

/**
 * Remove expired A2A JTI nonce rows.
 * Rows are safe to delete once expiresAt < now — the JWT window has closed
 * and the token can no longer be replayed legitimately.
 */
export async function cleanA2aJtiSeen(): Promise<number> {
  const r = await prisma.a2aJtiSeen.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return r.count;
}

/**
 * Remove stale A2A multi-turn session rows (A2ASessionTurn).
 * Pure storage hygiene: the route's own 10-minute functional TTL already
 * makes rows older than that invisible to reads (query-filtered in
 * getSession, src/app/api/a2a/jsonrpc/route.ts). This 1-day cutoff just
 * bounds table growth — generous on purpose, since it never affects
 * conversational correctness.
 */
export async function cleanA2aSessionTurns(now: number): Promise<number> {
  const cutoff1d = new Date(now - DAY_MS);
  const r = await prisma.a2ASessionTurn.deleteMany({
    where: { createdAt: { lt: cutoff1d } },
  });
  return r.count;
}

/**
 * Remove expired OAuthState rows. Rows are created at the start of the OAuth
 * connect flow and should be consumed (deleted) on callback. Any that were
 * abandoned accumulate until this cron sweeps them.
 */
export async function cleanOAuthState(): Promise<number> {
  const r = await prisma.oAuthState.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return r.count;
}

/**
 * Remove AiRateLimit rows older than 30 days. Each row is one (userId, date)
 * pair — keeping them beyond a month has no functional value and the table
 * grows by at least one row per active user per day.
 */
export async function cleanAiRateLimit(now: number): Promise<number> {
  const cutoff30d = new Date(now - 30 * DAY_MS);
  const r = await prisma.aiRateLimit.deleteMany({
    where: { date: { lt: cutoff30d } },
  });
  return r.count;
}

/**
 * Remove idempotency records stuck in "pending" for more than 5 minutes.
 * These are requests that started but never completed or released — typically
 * caused by a crash, timeout, or unhandled rejection in the handler.
 * The 5-minute window matches the original per-request prune TTL that was
 * removed from beginIdempotentMutation to avoid per-call DB overhead.
 */
export async function cleanStuckPendingIdempotencyRecords(now: number): Promise<number> {
  const pendingCutoff = new Date(now - 5 * 60 * 1000);
  const r = await prisma.idempotencyRecord.deleteMany({
    where: { status: "pending", updatedAt: { lt: pendingCutoff } },
  });
  return r.count;
}

/**
 * Remove expired WebhookSecurityIncident rows.
 * Rows are eligible for deletion once expiresAt < now (1-day TTL set on insert/update).
 * This keeps the table lean — active bans use blockedUntil which is well within the 1-day window.
 */
export async function cleanWebhookSecurityIncidents(): Promise<number> {
  const r = await prisma.webhookSecurityIncident.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return r.count;
}

/**
 * Orphan-reset: clear reconcileFastTrack on PaymentIntents that reached a
 * terminal state (confirmedAt IS NOT NULL or estado = "cancelled") via a path
 * other than the reconcile runner (e.g. manual owner confirm, webhook arriving
 * after flag was set, or audit-cleanup expiry transition). Leaves reconcileFailureCount and
 * reconcileLastError untouched — they are historical and useful for post-mortems.
 *
 * Bounded to 1 000 rows per run to keep the job time-boxed.
 * Idempotent: a confirmed PI with reconcileFastTrack already false is a no-op.
 *
 * 2026 cron-cleanup best practice: bounded, observable, additive-only writes.
 * Ref: bounded-batch-delete pattern — findMany(take: N) then deleteMany(id IN [...])
 */
export async function cleanReconcileFastTrackOrphans(): Promise<number> {
  const ORPHAN_RESET_CAP = 1_000;
  // Prisma updateMany does not support take/limit, so we fetch IDs first then
  // update in a single WHERE id IN (...) — bounded and index-friendly.
  const orphans = await prisma.paymentIntent.findMany({
    where: {
      reconcileFastTrack: true,
      OR: [
        { confirmedAt: { not: null } },
        { estado: "cancelled" },
      ],
    },
    select: { id: true },
    take: ORPHAN_RESET_CAP,
  });
  if (orphans.length === 0) return 0;
  const ids = orphans.map((o) => o.id);
  const r = await prisma.paymentIntent.updateMany({
    where: { id: { in: ids } },
    data: { reconcileFastTrack: false },
  });
  return r.count;
}
