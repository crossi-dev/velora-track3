-- Add onDelete: Cascade on Business.userId → User.id so deleting a User row
-- (e.g. owner clears their account) cascades to Business and through its FK
-- chain. Audit on 2026-05-24 found Business rows orphaned after a User delete
-- because the existing FK had no onDelete directive (defaulted to SetNull).
-- This means dashboard-driven User deletes used to leave Business + Products +
-- Sales + ChatMessages around (cleaned only later by TTL crons or manual SQL).

ALTER TABLE "Business" DROP CONSTRAINT IF EXISTS "Business_userId_fkey";
ALTER TABLE "Business" ADD CONSTRAINT "Business_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
