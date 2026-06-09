-- Migration: add CHECK constraint to enforce negative stock floor on Product
-- Fixes H1: allowNegativeStock=true bypasses TOCTOU guard with no floor at DB level.
-- Floor of -9999 prevents runaway negative stock from bugs, import errors, or race conditions.

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_quantity_floor_check"
  CHECK (quantity >= -9999);
