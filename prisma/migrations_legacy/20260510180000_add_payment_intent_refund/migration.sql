-- PaymentIntent refund — slice 5 del módulo Cobro QR ("devolución cash V1").
--
-- Cuando el empleado clickea "Devolver" en una card de cobro confirmado:
--   1. PaymentIntent.estado pasa a "refunded".
--   2. Se setea refundedAt (now) + refundedByEmployeeId (null si owner).
--   3. Se registra CashMovement negativo por el monto del intent.
--
-- V1: NO toca la API de MP, solo compensa la caja del negocio. La devolución
-- al cliente la negocia el dueño/empleado fuera del sistema (cash en mano).
-- V2 (post-evento): integración con MP refund API automática.
--
-- Aditiva, nullable: rows existentes arrancan con NULL (sin devolución previa);
-- futuras devoluciones pueblan ambos campos atómicamente.

ALTER TABLE "PaymentIntent" ADD COLUMN "refundedAt" TIMESTAMP(3);
ALTER TABLE "PaymentIntent" ADD COLUMN "refundedByEmployeeId" TEXT;
