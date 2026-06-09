-- Per-owner toggle to enable low-stock WhatsApp alerts. Default OFF
-- (changed 2026-05-25 — was implicit ON via whatsappPhone presence).
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "notifyLowStockWa" BOOLEAN NOT NULL DEFAULT false;
