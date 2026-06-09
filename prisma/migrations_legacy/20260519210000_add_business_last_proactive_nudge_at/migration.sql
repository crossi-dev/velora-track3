-- Migration: add Business.lastProactiveNudgeAt
-- Tracks when the once-daily onboarding nudge last fired per business (ART tz).
-- Replaces the __proactive_nudge__ ChatMessage sentinel that polluted chat history.
-- ownerDailyNudgeStage reads this field at request time; no Cloud Scheduler needed.
--
-- Nullable: existing rows have no nudge history — they will receive the nudge
-- on the next chat open if onboarding is still incomplete.
--
-- DO NOT APPLY via `prisma db execute` automatically.
-- Apply manually against the production DATABASE_URL (Neon) when ready.

ALTER TABLE "Business" ADD COLUMN "lastProactiveNudgeAt" TIMESTAMP(3);
