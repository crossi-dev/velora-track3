-- Migration: 20260603000000_add_caja_session
-- Adds CajaSession table — cash drawer shift per business.
--
-- Shape sourced from Square CashDrawerShift API (industry-standard reference):
--   https://developer.squareup.com/reference/square/cash-drawers-api
--
-- States: OPEN (shift in progress) → CLOSED (shift settled).
--
-- openedCashAmount  — float declared by the employee who opened the drawer.
-- closedCashAmount  — float counted by the employee who closed the drawer.
-- expectedCashAmount — computed at close: openedCashAmount + net cash movements.
-- variance          — closedCashAmount − expectedCashAmount (negative = shortage).
--
-- openedByEmployeeId / closedByEmployeeId — nullable (owner-only flows have no Employee row).
--
-- DO NOT apply automatically — run manually against prod:
--   npx prisma db execute --file prisma/migrations/20260603000000_add_caja_session/migration.sql
--
-- Additive only — new table, two nullable FK columns on Employee (via back-relations).
-- Zero risk to existing rows. No data loss. Safe to apply with zero downtime.

CREATE TABLE IF NOT EXISTS "CajaSession" (
    "id"                   TEXT          NOT NULL,
    "businessId"           TEXT          NOT NULL,
    "state"                TEXT          NOT NULL DEFAULT 'OPEN',
    "openedAt"             TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedCashAmount"     DOUBLE PRECISION NOT NULL,
    "closedAt"             TIMESTAMP(3),
    "closedCashAmount"     DOUBLE PRECISION,
    "expectedCashAmount"   DOUBLE PRECISION,
    "variance"             DOUBLE PRECISION,
    "openNote"             TEXT,
    "closeNote"            TEXT,
    "openedByEmployeeId"   TEXT,
    "closedByEmployeeId"   TEXT,
    "createdAt"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"            TIMESTAMP(3)  NOT NULL,

    CONSTRAINT "CajaSession_pkey" PRIMARY KEY ("id")
);

-- Indexes for the two primary query patterns:
--   1. List open/closed sessions per business (state filter).
--   2. Chronological session history per business.
CREATE INDEX IF NOT EXISTS "CajaSession_businessId_state_idx"
    ON "CajaSession"("businessId", "state");

CREATE INDEX IF NOT EXISTS "CajaSession_businessId_openedAt_idx"
    ON "CajaSession"("businessId", "openedAt");

-- C2: Partial unique index — at most one OPEN session per business at a time.
-- A TOCTOU race on the findFirst(OPEN) → create(OPEN) sequence can be lost
-- under concurrent calls; this index makes the DB the authoritative guard.
-- The WHERE clause limits the constraint to OPEN rows only, so a business can
-- have many CLOSED sessions without violating uniqueness.
-- Pattern: Postgres partial unique index (PostgreSQL docs §11.8 "Partial Indexes").
-- Catch Prisma error code P2002 on create → return SESSION_ALREADY_OPEN instead
-- of propagating a 5xx to the LLM (handled in execute above).
-- DO NOT apply to prod automatically — see header note.
CREATE UNIQUE INDEX IF NOT EXISTS "CajaSession_businessId_open_unique"
    ON "CajaSession"("businessId")
    WHERE state = 'OPEN';

-- Foreign keys
ALTER TABLE "CajaSession"
    ADD CONSTRAINT "CajaSession_businessId_fkey"
    FOREIGN KEY ("businessId")
    REFERENCES "Business"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "CajaSession"
    ADD CONSTRAINT "CajaSession_openedByEmployeeId_fkey"
    FOREIGN KEY ("openedByEmployeeId")
    REFERENCES "Employee"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

ALTER TABLE "CajaSession"
    ADD CONSTRAINT "CajaSession_closedByEmployeeId_fkey"
    FOREIGN KEY ("closedByEmployeeId")
    REFERENCES "Employee"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;
