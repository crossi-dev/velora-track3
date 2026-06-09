-- Fase C2: condición IVA del cliente para determinar tipo de comprobante.
-- "Responsable Inscripto" → Factura A; "Monotributista" / "Consumidor Final" / "Exento" → Factura B / C.
-- Aditivo y nullable — filas existentes quedan con NULL, el Fiscal Agent usa Factura C como fallback.

ALTER TABLE "Customer" ADD COLUMN IF NOT EXISTS "ivaCondition" TEXT;
