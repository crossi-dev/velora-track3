-- Add shipping and lifecycle columns to PaymentIntent.
-- All five are nullable for backward compatibility with existing rows.
--
-- shippingRequired:  boolean flag — true when the link includes gastos de envío.
--                    Default false matches the schema default.
-- shippingAddress:   JSONB payload with destination address
--                    (street, postalCode, city, notes). Null until shipping is included.
-- shippingCostARS:   freight amount in ARS. Same Decimal(12,2) type as `monto`.
-- comprobanteSentAt: timestamp when the sale receipt was sent via WhatsApp.
-- shipmentCreatedAt: timestamp when the Andreani Agent created the shipment.
ALTER TABLE "PaymentIntent" ADD COLUMN "shippingRequired"  BOOLEAN     NOT NULL DEFAULT false;
ALTER TABLE "PaymentIntent" ADD COLUMN "shippingAddress"   JSONB;
ALTER TABLE "PaymentIntent" ADD COLUMN "shippingCostARS"   DECIMAL(12,2);
ALTER TABLE "PaymentIntent" ADD COLUMN "comprobanteSentAt" TIMESTAMPTZ;
ALTER TABLE "PaymentIntent" ADD COLUMN "shipmentCreatedAt" TIMESTAMPTZ;
