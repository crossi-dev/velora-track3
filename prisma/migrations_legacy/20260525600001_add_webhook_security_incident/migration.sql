-- Migration: 20260525600001_add_webhook_security_incident
-- Replaces the in-memory mismatchTracker Map in webhook-security.ts with a
-- DB-backed table so IP ban counters are shared across all Cloud Run instances.
--
-- Pattern: upsert on (ipAddress, eventType) increments count; when count reaches
-- threshold, blockedUntil is written. All instances query this table on each
-- inbound webhook — no per-instance state involved.
--
-- Cleanup: audit-cleanup cron deletes rows WHERE "expiresAt" < now().
-- expiresAt index makes that DELETE O(pruned).
-- Row TTL = 1 day from first incident (reset on each new hit).

CREATE TABLE "WebhookSecurityIncident" (
    "id"           TEXT         NOT NULL,
    "ipAddress"    TEXT         NOT NULL,
    "eventType"    TEXT         NOT NULL,
    "count"        INTEGER      NOT NULL DEFAULT 1,
    "firstSeenAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt"   TIMESTAMP(3) NOT NULL,
    "blockedUntil" TIMESTAMP(3),
    "expiresAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSecurityIncident_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WebhookSecurityIncident_ipAddress_eventType_key"
    ON "WebhookSecurityIncident"("ipAddress", "eventType");

CREATE INDEX "WebhookSecurityIncident_ipAddress_eventType_idx"
    ON "WebhookSecurityIncident"("ipAddress", "eventType");

CREATE INDEX "WebhookSecurityIncident_expiresAt_idx"
    ON "WebhookSecurityIncident"("expiresAt");
