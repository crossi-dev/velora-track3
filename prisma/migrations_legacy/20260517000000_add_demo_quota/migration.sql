-- Add demo-quota fields to the Business table.
-- All three columns have server-side defaults so existing rows are
-- backward compatible without a data migration step.
-- demoMode=true: every business starts in demo mode until the owner
--   converts to a paying account (flip via prisma.business.update).
-- demoActionsUsed: incremented inside the mutation transaction each
--   time a money-path action succeeds (sale, stock-load, cash-movement).
-- demoActionsLimit: 50 by default; can be overridden per-business.
ALTER TABLE "Business" ADD COLUMN "demoMode" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Business" ADD COLUMN "demoActionsUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Business" ADD COLUMN "demoActionsLimit" INTEGER NOT NULL DEFAULT 50;
