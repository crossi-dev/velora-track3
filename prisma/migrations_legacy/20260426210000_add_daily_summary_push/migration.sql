-- Daily-summary push notifications (Flujo 2).
--
-- Two tables:
--   1. PushSubscription — Web Push (VAPID) subscriptions per (business, device).
--      One row per browser/PWA install that opted in via Notification.requestPermission().
--      The cron at 20:00 AR fans out to every non-expired row.
--      `expired` flips true when the push service returns 404 or 410. We never
--      delete to preserve audit/debug history.
--
--   2. DailySummaryPushLog — operational idempotency for the daily cron.
--      UNIQUE(businessId, dateAR) makes the cron at-most-once per calendar
--      day in Argentina TZ even if Vercel retries within the same window.
--
-- Both tables are append-only / status-mutating; no FK to Business so we don't
-- need cascading on delete (push history outlives the business if it ever
-- archives — useful for support).

CREATE TABLE "PushSubscription" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "deviceLabel" TEXT,
    "expired" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PushSubscription_businessId_endpoint_key"
    ON "PushSubscription"("businessId", "endpoint");

CREATE INDEX "PushSubscription_businessId_expired_idx"
    ON "PushSubscription"("businessId", "expired");

CREATE TABLE "DailySummaryPushLog" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "dateAR" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailySummaryPushLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DailySummaryPushLog_businessId_dateAR_key"
    ON "DailySummaryPushLog"("businessId", "dateAR");

CREATE INDEX "DailySummaryPushLog_dateAR_idx"
    ON "DailySummaryPushLog"("dateAR");
