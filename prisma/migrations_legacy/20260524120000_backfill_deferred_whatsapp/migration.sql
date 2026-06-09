-- Backfill whatsappPhone from NULL to '' (the "deferred" sentinel) for
-- businesses that completed onboarding in a version that did not have the
-- T6 (WhatsApp) turn. Without this, load-context.ts derives
-- whatsappPhoneSet from `whatsappPhone IS NOT NULL`, so any business with
-- NULL is forced through T6 forever even though it finished onboarding.
--
-- Scope:
--   * whatsappPhone IS NULL — only the rows that exhibit the bug
--   * paymentMethods != '{}' — only businesses that progressed past T3
--     (so we skip rows still mid-onboarding in the new flow)
--   * createdAt < CURRENT_DATE — only businesses created before today,
--     to avoid clobbering anyone currently going through onboarding
--
-- Reversible: UPDATE "Business" SET "whatsappPhone" = NULL WHERE "whatsappPhone" = '' AND <same filters>;
UPDATE "Business"
SET "whatsappPhone" = ''
WHERE "whatsappPhone" IS NULL
  AND "paymentMethods" != '{}'
  AND "createdAt" < CURRENT_DATE;
