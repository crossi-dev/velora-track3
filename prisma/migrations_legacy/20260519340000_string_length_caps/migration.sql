-- Migration: 20260519340000_string_length_caps
--
-- Pre-flight queries to run BEFORE applying this migration.
-- If any count > 0, rows exceed the new cap and the ALTER will fail.
-- Investigate and truncate/fix those rows before proceeding.
--
--   SELECT count(*) FROM "ChatMessage" WHERE length(text) > 8192;
--   SELECT count(*) FROM "BusinessRule" WHERE length(message) > 2000;
--   SELECT count(*) FROM "CashMovement" WHERE length(description) > 2000;
--   SELECT count(*) FROM "DelegationPolicy" WHERE length(conditions) > 2000;
--   SELECT count(*) FROM "Employee" WHERE length("pinHash") > 200;
--   SELECT count(*) FROM "AgentEventLog" WHERE length("eventId") > 128;
--   SELECT count(*) FROM "Product" WHERE length(name) > 255;
--   SELECT count(*) FROM "Customer" WHERE length(name) > 255;
--   SELECT count(*) FROM "Supplier" WHERE length(name) > 255;
--   SELECT count(*) FROM "Employee" WHERE length(name) > 255;
--
-- Apply with:
--   npx prisma db execute --file prisma/migrations/20260519340000_string_length_caps/migration.sql

-- VarChar caps on user-provided string fields
ALTER TABLE "Employee"
  ALTER COLUMN "name" TYPE varchar(255) USING "name"::varchar(255),
  ALTER COLUMN "pinHash" TYPE varchar(200) USING "pinHash"::varchar(200);

ALTER TABLE "Product"
  ALTER COLUMN "name" TYPE varchar(255) USING "name"::varchar(255);

ALTER TABLE "Customer"
  ALTER COLUMN "name" TYPE varchar(255) USING "name"::varchar(255);

ALTER TABLE "Supplier"
  ALTER COLUMN "name" TYPE varchar(255) USING "name"::varchar(255);

ALTER TABLE "ChatMessage"
  ALTER COLUMN "text" TYPE varchar(8192) USING "text"::varchar(8192);

ALTER TABLE "BusinessRule"
  ALTER COLUMN "message" TYPE varchar(2000) USING "message"::varchar(2000);

ALTER TABLE "CashMovement"
  ALTER COLUMN "description" TYPE varchar(2000) USING "description"::varchar(2000);

ALTER TABLE "DelegationPolicy"
  ALTER COLUMN "conditions" TYPE varchar(2000) USING "conditions"::varchar(2000);

ALTER TABLE "AgentEventLog"
  ALTER COLUMN "eventId" TYPE varchar(128) USING "eventId"::varchar(128);

-- responseBody becomes TEXT explicitly (was implicit text — no data change, just clarifies intent)
ALTER TABLE "IdempotencyRecord"
  ALTER COLUMN "responseBody" TYPE text USING "responseBody"::text;

-- Decimal precision for taxRate and openingCash
ALTER TABLE "Business"
  ALTER COLUMN "taxRate" TYPE numeric(12,4) USING "taxRate"::numeric(12,4),
  ALTER COLUMN "openingCash" TYPE numeric(14,2) USING "openingCash"::numeric(14,2);

-- ML token encryption columns (nullable — existing rows default to plaintext fallback)
ALTER TABLE "MlCredential"
  ADD COLUMN IF NOT EXISTS "accessTokenCiphertext" text,
  ADD COLUMN IF NOT EXISTS "refreshTokenCiphertext" text;
