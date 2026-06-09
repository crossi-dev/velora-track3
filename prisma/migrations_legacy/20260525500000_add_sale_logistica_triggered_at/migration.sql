-- Add logisticaTriggeredAt to Sale for idempotency guard on Andreani shipment creation.
-- Prevents dual-path duplicate: both sale-post-commit and payment-intent-post-confirm
-- could previously fire shipment.create for the same sale concurrently.
-- The atomic updateMany(where: logisticaTriggeredAt IS NULL) pattern ensures only
-- one caller wins the race; the other sees count=0 and skips the Andreani API call.
-- Migración: 20260525400000_add_sale_logistica_triggered_at.sql

ALTER TABLE "Sale" ADD COLUMN "logisticaTriggeredAt" TIMESTAMP(3);
