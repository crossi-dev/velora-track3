-- Migration: add Employee.lastWelcomeAt
-- Tracks when the once-daily Companion greeting last fired per employee (ART tz).
-- employeeDailyWelcomeStage reads this field at request time; no Cloud Scheduler needed.
-- Mirrors Business.lastProactiveNudgeAt (migration 20260519210000) on the employee side.
--
-- Nullable: existing rows have no welcome history — they will receive the greeting
-- on the next chat open after their onboarding is complete.
--
-- DO NOT APPLY via `prisma db execute` automatically.
-- Apply manually against the production DATABASE_URL (Neon) when ready.

ALTER TABLE "Employee" ADD COLUMN "lastWelcomeAt" TIMESTAMP(3);
