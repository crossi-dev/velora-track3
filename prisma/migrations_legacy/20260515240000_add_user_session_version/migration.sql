-- Migration: add sessionVersion to User for stateless JWT invalidation.
-- Default 1 so all existing rows start valid — no forced logout on deploy.
-- Increment via invalidateUserSession() to revoke all JWTs for a user.

ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 1;
