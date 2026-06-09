-- Promesa de pago (deferred payment) — adds the expected-payment-date field
-- to PaymentIntent. Set when metodo="promesa" + owner manually confirms.
-- Stripe's "manual confirm" + accrual basis Accounts Receivable pattern.

ALTER TABLE "PaymentIntent"
  ADD COLUMN IF NOT EXISTS "promesaExpectedAt" TIMESTAMP(3);
