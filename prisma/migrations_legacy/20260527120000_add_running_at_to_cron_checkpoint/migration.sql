-- Add runningAt to CronCheckpoint for distributed cron-lock (HIGH-3-3).
-- runningAt is set to now() at run start and cleared in the finally block.
-- If fresh (< LEASE_TTL_MS), the next Cloud Scheduler tick detects the active
-- lease and skips execution, preventing duplicate processing across Cloud Run
-- instances.
ALTER TABLE "CronCheckpoint" ADD COLUMN "runningAt" TIMESTAMP(3);
