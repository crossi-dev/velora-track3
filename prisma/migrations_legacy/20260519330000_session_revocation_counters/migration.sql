-- Migration: 20260519330000_session_revocation_counters
-- Adds session revocation version counters for Employee and Business (owner).
-- Employee.sessionVersion is incremented on PIN change or manual revocation;
-- Business.loginTokenVersion is incremented on owner account revocation events.
-- Both columns default to 1 so existing rows are valid without a data migration.

ALTER TABLE "Employee" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Business" ADD COLUMN "loginTokenVersion" INTEGER NOT NULL DEFAULT 1;
