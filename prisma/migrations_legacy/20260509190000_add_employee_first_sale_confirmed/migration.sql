-- Tracks whether THIS specific employee has closed at least one sale
-- through the chat. Used by the post-commit hook to fire the Web Push
-- priming message exactly once per employee (mirrors the existing
-- Business.firstSaleConfirmed flag for the owner). Defaults to false
-- so existing rows do not skip the primer the first time around.
ALTER TABLE "Employee" ADD COLUMN "firstSaleConfirmed" BOOLEAN NOT NULL DEFAULT false;
