-- PaymentIntent.expiresAt — slice 3 del módulo Cobro QR ("timeout 2 min").
--
-- Defensa anti-comprobante-falso: el QR/alias expira a los 2 minutos. Si el
-- empleado intenta confirmar tras expirar, la API responde 410 EXPIRED y el
-- intent transiciona a estado "expired" (lazy, sin cron sweeper).
--
-- Aditiva, nullable: rows existentes arrancan con NULL (sin timeout aplicado);
-- los nuevos PaymentIntents siempre traen expiresAt = createdAt + 2 minutos.

ALTER TABLE "PaymentIntent" ADD COLUMN "expiresAt" TIMESTAMP(3);
