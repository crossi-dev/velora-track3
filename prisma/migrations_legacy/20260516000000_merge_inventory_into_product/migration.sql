-- Migration: merge Inventory model into Product.quantity
-- Velora simplification Batch 3
-- SAFE ORDER: add column → backfill → drop table
-- DO NOT apply this to production without a review window.

-- Step (a): Add the quantity column to Product with default 0.
-- Existing rows get 0; the backfill in step (b) overwrites them.
ALTER TABLE "Product" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 0;

-- Step (b): Backfill Product.quantity from the Inventory table.
-- All products with an Inventory row get their real stock.
-- Products with no Inventory row keep 0 (safe fallback).
UPDATE "Product"
SET "quantity" = i."quantity"
FROM "Inventory" i
WHERE i."productId" = "Product"."id";

-- Step (c): Drop the Inventory table.
-- All data has been migrated to Product.quantity above.
DROP TABLE "Inventory";
