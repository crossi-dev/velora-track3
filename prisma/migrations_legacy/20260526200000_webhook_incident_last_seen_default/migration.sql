-- Migration: 20260526200000_webhook_incident_last_seen_default
--
-- REG-T2-3: add DEFAULT CURRENT_TIMESTAMP to WebhookSecurityIncident.lastSeenAt.
--
-- The original migration (20260525600001) declared lastSeenAt NOT NULL with no
-- DEFAULT. Prisma's @updatedAt decorator injects the value at query time so
-- all Prisma-generated queries work correctly. However, any raw SQL INSERT
-- that omits lastSeenAt would fail with a NOT NULL constraint violation,
-- creating a hidden dependency on the Prisma client that is not enforced at
-- the DB schema level.
--
-- This follow-up migration makes the schema self-documenting and safe for
-- direct DB access or future migration backfills.

ALTER TABLE "WebhookSecurityIncident"
  ALTER COLUMN "lastSeenAt" SET DEFAULT CURRENT_TIMESTAMP;
