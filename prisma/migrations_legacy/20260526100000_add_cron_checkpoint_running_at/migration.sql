-- Migration: 20260526100000_add_cron_checkpoint_running_at
--
-- HIGH-3-3: CronLock pattern — adds runningAt column to CronCheckpoint so
-- overlapping invocations of rule-alerts (Cloud Scheduler every 5 min) can
-- detect a live run and skip rather than producing duplicate evaluations.
--
-- Usage: on run start, upsert runningAt = now(). On completion (finally),
-- update runningAt = null. On next invocation, read runningAt: if it is
-- non-null and < 4 minutes ago, return 200 immediately (already running).
--
-- Nullable: existing rows are unaffected. A null means idle or unknown state
-- (safe to proceed). A non-null value within the lock window means another
-- instance holds the lock.

ALTER TABLE "CronCheckpoint" ADD COLUMN "runningAt" TIMESTAMP(3);
