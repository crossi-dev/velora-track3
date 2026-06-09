-- Add 3 deferred-step flags to Business so the owner can skip the T12/T13/T14
-- onboarding turns without re-prompting forever (the audit found that without
-- these flags the state machine looped on each turn because customerCount,
-- arcaCertConnected, courierCredentialsConnected stayed false on defer).

ALTER TABLE "Business"
  ADD COLUMN IF NOT EXISTS "customersOnboardingSkipped" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "arcaOnboardingDeferred"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "andreaniOnboardingDeferred" BOOLEAN NOT NULL DEFAULT false;
