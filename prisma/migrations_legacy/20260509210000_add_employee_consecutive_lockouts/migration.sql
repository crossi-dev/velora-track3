-- Exponential backoff for the employee PIN lockout.
-- The pre-existing lockout was a fixed 15-minute window after 5 failed
-- attempts; an attacker could grind PINs steadily across many cycles
-- (4 digits = 10000 combinations). This adds a per-account counter that
-- escalates the lockout duration on repeated lockouts:
--   1st lockout  → 5  minutes
--   2nd lockout  → 15 minutes
--   3rd lockout  → 1  hour
--   4th lockout  → 6  hours
--   5th lockout+ → 24 hours (cap)
-- The counter is reset to 0 on a successful login. It must persist past
-- the active lockout window — otherwise the schedule resets every cycle
-- and the cap is meaningless.
--
-- Aditiva: agrega 1 columna a Employee. NO toca data existente.

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN "consecutiveLockouts" INTEGER NOT NULL DEFAULT 0;
