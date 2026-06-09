-- CronCheckpoint: singleton-per-job row that tracks the last successful
-- scheduled run, so the handler can iterate every missed 5-min slot
-- between `lastRunAt` and "now" (capped at the in-code catch-up window).
-- Idempotency lives at the ChatMessage level (clientMessageId per
-- rule+slot+employee), so replaying overlapping slots is safe.
CREATE TABLE "CronCheckpoint" (
    "jobName" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronCheckpoint_pkey" PRIMARY KEY ("jobName")
);
