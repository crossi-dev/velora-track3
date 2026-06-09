-- Migration: add PaymentConfirmDlq table for Cloud Tasks dead-letter queue records.
-- Written by: the DLQ Pub/Sub push subscriber at /api/internal/dlq/payment-confirm.
-- Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues#RetryConfig

CREATE TABLE "PaymentConfirmDlq" (
    "id"               TEXT NOT NULL,
    "taskName"         TEXT NOT NULL,
    "paymentIntentId"  TEXT NOT NULL,
    "businessId"       TEXT NOT NULL,
    "rawMessage"       TEXT NOT NULL,
    "lastError"        TEXT,
    "attemptCount"     INTEGER NOT NULL DEFAULT 0,
    "resolvedAt"       TIMESTAMP(3),
    "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"        TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentConfirmDlq_pkey" PRIMARY KEY ("id")
);

-- Unique on taskName: deduplicates Pub/Sub at-least-once delivery.
CREATE UNIQUE INDEX "PaymentConfirmDlq_taskName_key" ON "PaymentConfirmDlq"("taskName");

CREATE INDEX "PaymentConfirmDlq_businessId_idx" ON "PaymentConfirmDlq"("businessId");
CREATE INDEX "PaymentConfirmDlq_paymentIntentId_idx" ON "PaymentConfirmDlq"("paymentIntentId");
