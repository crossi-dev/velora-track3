-- Migration: 20260525930000_add_stockload_parent
-- Adds the StockLoad saga record that tracks an entire stock ingress batch
-- atomically. Rows are written BEFORE items commit (status='in_progress'),
-- updated to 'completed' inside the same transaction, or marked 'failed'
-- in the catch block. Ensures partial ingress is always visible as failed
-- rather than silently committed.

CREATE TYPE "StockLoadStatus" AS ENUM ('in_progress', 'completed', 'failed');

CREATE TABLE "StockLoad" (
  "id"             TEXT NOT NULL,
  "businessId"     TEXT NOT NULL,
  "status"         "StockLoadStatus" NOT NULL DEFAULT 'in_progress',
  "itemCount"      INTEGER NOT NULL,
  "completedCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt"    TIMESTAMP(3),
  "errorReason"    TEXT,

  CONSTRAINT "StockLoad_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StockLoad_businessId_createdAt_idx" ON "StockLoad"("businessId", "startedAt");

ALTER TABLE "StockLoad" ADD CONSTRAINT "StockLoad_businessId_fkey"
  FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;
