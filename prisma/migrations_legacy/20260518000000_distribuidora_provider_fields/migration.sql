-- Distribuidora-ready (Fase A): campos de preferencia de proveedor.
-- Aditivo — todas las columnas son nullable o con default, seguro de aplicar
-- en caliente: el código existente las ignora.

-- Courier preferido del negocio: "Andreani" | "OCA" | "ninguno".
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "courierPreference" TEXT;

-- Proveedor de cobro del negocio: "mercadopago" (default) | "alias_cbu" | futuro "banco_galicia".
ALTER TABLE "Business" ADD COLUMN IF NOT EXISTS "paymentProvider" TEXT DEFAULT 'mercadopago';

-- Referencia del proveedor de pago (MP: preferenceId). Provider-neutral.
ALTER TABLE "PaymentIntent" ADD COLUMN IF NOT EXISTS "providerRef" TEXT;
