-- PaymentIntent — slice 1 del módulo de Cobro QR.
--
-- Tracer bullet end-to-end: el empleado tipea "cobro 5000" en el chat,
-- se persiste un intento de cobro pendiente con QR placeholder, y al
-- apretar "marcar cobrado" la venta se cierra. Slices posteriores
-- reemplazan el QR fake por el QR dinámico real de Mercado Pago via
-- OAuth + webhook.
--
-- Compositional contract:
--   - payment_intent.create                     (slice 1)
--   - payment_intent.confirm  → sale.update-status + cash-movement.create
--
-- Aditiva: crea 1 tabla nueva. NO toca data existente. Sin downtime.

-- CreateTable
CREATE TABLE "PaymentIntent" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "saleId" TEXT,
    "monto" DECIMAL(12,2) NOT NULL,
    "metodo" TEXT NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'pending',
    "idempotencyKey" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmedByEmployeeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (unique por business + idempotencyKey — habilita reintentos seguros del chat)
CREATE UNIQUE INDEX "PaymentIntent_businessId_idempotencyKey_key" ON "PaymentIntent"("businessId", "idempotencyKey");

-- CreateIndex (cubre listados por estado + tiempo)
CREATE INDEX "PaymentIntent_businessId_estado_createdAt_idx" ON "PaymentIntent"("businessId", "estado", "createdAt");

-- CreateIndex (lookup por venta — reverse lookup desde Sale)
CREATE INDEX "PaymentIntent_saleId_idx" ON "PaymentIntent"("saleId");

-- AddForeignKey
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (saleId nullable → ON DELETE SET NULL preserva el intent en audit aunque la venta haya sido borrada)
ALTER TABLE "PaymentIntent" ADD CONSTRAINT "PaymentIntent_saleId_fkey" FOREIGN KEY ("saleId") REFERENCES "Sale"("id") ON DELETE SET NULL ON UPDATE CASCADE;
