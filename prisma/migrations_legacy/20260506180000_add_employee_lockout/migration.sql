-- Per-account PIN lockout: track failed attempts and lock time.
-- After 5 failed attempts in 15 min the account is locked until owner resets it.
-- Aditiva: agrega 2 columnas a Employee. NO toca data existente.

-- AlterTable
ALTER TABLE "Employee" ADD COLUMN "failedPinAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Employee" ADD COLUMN "lockedUntil" TIMESTAMP(3);
