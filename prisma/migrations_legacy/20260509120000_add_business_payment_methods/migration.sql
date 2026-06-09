-- Step 1 of chat-driven owner onboarding migration:
-- Persist payment methods captured during the 6-turn onboarding flow.
-- Postgres text[] preserves the multi-select shape ("Efectivo", "Mercado Pago", "Tarjeta", "Transferencia")
-- without forcing JSON parsing on every read. Default empty array keeps existing rows valid.
ALTER TABLE "Business" ADD COLUMN "paymentMethods" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- openingCashConfigured tracks whether the owner explicitly set their starting cash, since 0
-- is a legitimate value that cannot be distinguished from "never asked" otherwise. Used by
-- the supervisor onboardingState to know if turn 4 has already been answered.
ALTER TABLE "Business" ADD COLUMN "openingCashConfigured" BOOLEAN NOT NULL DEFAULT false;
