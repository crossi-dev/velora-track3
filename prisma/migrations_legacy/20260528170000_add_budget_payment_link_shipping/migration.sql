-- Migration: add_budget_payment_link_shipping
--
-- Adds:
--   1. Budget.shippingCostAmount — shipping cost line for Customer Agent formal quotes.
--   2. Budget.paymentLinkUrl     — MercadoPago checkout URL embedded in the PDF
--                                  "Pagá online" section.
--
-- Both fields are nullable: pre-existing budgets created by the owner from the
-- dashboard remain valid; only Customer Agent quote flow populates them.
--
-- Sources:
--   Stripe Checkout (quote + payment link pattern):
--     https://docs.stripe.com/payments/quotes
--   MercadoPago Checkout Pro (init_point persistence):
--     https://www.mercadopago.com.ar/developers/es/docs/checkout-pro

ALTER TABLE "Budget" ADD COLUMN "shippingCostAmount" DECIMAL(12, 2);
ALTER TABLE "Budget" ADD COLUMN "paymentLinkUrl" TEXT;
