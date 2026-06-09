-- Tracks whether the owner has closed at least one sale through the chat.
-- Used by the post-commit hook to fire the Web Push priming message exactly
-- once (right after T6 of the conversational onboarding ends with the first
-- test sale). Defaults to false so existing rows do not skip the primer.
ALTER TABLE "Business" ADD COLUMN "firstSaleConfirmed" BOOLEAN NOT NULL DEFAULT false;
