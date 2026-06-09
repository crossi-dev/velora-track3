-- Performance indexes added 2026-05-23 (debt audit C7).
-- Applied directly to Supabase via psql; tracked here for the migration history.

-- CriticalWriteEvent: audit-cleanup cron does `DELETE WHERE createdAt < cutoff`
-- with no businessId filter. Standalone (createdAt) index avoids scanning the
-- leading column of the composite (businessId, actionType, createdAt).
CREATE INDEX IF NOT EXISTS "CriticalWriteEvent_createdAt_idx" ON "CriticalWriteEvent"("createdAt");

-- SaleItem: planner-velocity does saleItem.groupBy with WHERE saleId IN [...]
-- aggregating SUM(quantity) by productId. Composite covers the group-by + sum.
CREATE INDEX IF NOT EXISTS "SaleItem_saleId_productId_quantity_idx" ON "SaleItem"("saleId", "productId", "quantity");

-- StockMovement: per-business + per-product velocity queries are filtered by
-- businessId+productId+createdAt range. Composite avoids a memory-side filter
-- on productId after a businessId+createdAt range scan.
CREATE INDEX IF NOT EXISTS "StockMovement_businessId_productId_createdAt_idx" ON "StockMovement"("businessId", "productId", "createdAt");
