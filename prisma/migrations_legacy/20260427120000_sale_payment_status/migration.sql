-- Flujo 3 — Pendiente de cobro
--
-- Antes de Flujo 3, todas las ventas eran cobradas inmediatamente: el handler
-- sale.create escribía Sale.status="completed" y un CashMovement type="sale"
-- con el total. No había modelo de fiado.
--
-- Esta migración:
--   1. Migra ventas existentes "completed" → "paid". Cambio de etiqueta solamente,
--      cero impacto en datos. La codebase no condiciona sobre status="completed"
--      en ningún lado (verificado en audit pre-migración).
--   2. Cambia el default de Sale.status a "paid" alineado con la nueva semántica.
--   3. Agrega Sale.amountPaid Decimal nullable. null cuando status="paid"
--      (se asume = totalAmount) o status="pending" (no se cobró nada todavía).
--      Requerido cuando status="partial".
--   4. Agrega índice (businessId, status) para queries de "pendientes de cobro".
--
-- PREFLIGHT (run before applying in production to verify count is sane):
--   SELECT COUNT(*) FROM "Sale" WHERE "status" = 'completed';
--   SELECT COUNT(*) FROM "Sale" WHERE "status" NOT IN ('completed', 'paid', 'partial', 'pending');
-- Expected: la primera = todas las ventas pre-Flujo 3; la segunda = 0.

UPDATE "Sale" SET "status" = 'paid' WHERE "status" = 'completed';

ALTER TABLE "Sale" ALTER COLUMN "status" SET DEFAULT 'paid';

ALTER TABLE "Sale" ADD COLUMN "amountPaid" DECIMAL(65,30);

CREATE INDEX "Sale_businessId_status_idx" ON "Sale"("businessId", "status");
