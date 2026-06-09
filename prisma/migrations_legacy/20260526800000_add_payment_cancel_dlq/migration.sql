-- Migration: add PaymentCancelDlq table for velora-payment-cancel dead-letter queue records.
-- Written by: the DLQ Pub/Sub push subscriber at /api/internal/dlq/payment-cancel.
-- Mirrors PaymentConfirmDlq — every queue must have symmetric DLQ coverage.
-- Ref: https://cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues#RetryConfig

CREATE TABLE "PaymentCancelDlq" (
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

    CONSTRAINT "PaymentCancelDlq_pkey" PRIMARY KEY ("id")
);

-- Unique on taskName: deduplicates Pub/Sub at-least-once delivery.
CREATE UNIQUE INDEX "PaymentCancelDlq_taskName_key" ON "PaymentCancelDlq"("taskName");

CREATE INDEX "PaymentCancelDlq_businessId_idx" ON "PaymentCancelDlq"("businessId");
CREATE INDEX "PaymentCancelDlq_paymentIntentId_idx" ON "PaymentCancelDlq"("paymentIntentId");
