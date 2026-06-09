// Observability helpers for confirm-transaction.ts — extracted to keep the
// parent module under the 300-line hard limit (CLAUDE.md code size standards).
//
// Covers items 1–5 of the 2026 industry-standard hardening:
//   1. DLQ audit: CriticalWriteEvent on permanent batch failure
//   2. Dedup metric: WARNING log for P2002 hits (drives log-based metric)
//   3. Race observability: MP_CONFIRM_STATE_RACE_LOST when piUpdateMany.count=0
//   4. Sale race: MP_CONFIRM_SALE_RACE_LOST when saleUpdateMany.count=0
//   5. Unknown metodo guard (lives in parent — pure function, no helpers needed)
//
// Ref: cloud.google.com/logging/docs/logs-based-metrics
//      stripe.com/docs/error-handling
//      brandur.org/idempotency-keys

import { Prisma } from "@prisma/client";
import { cloudLog } from "@/lib/cloud-logger";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { prisma } from "@/lib/prisma";

// ── Error classification ───────────────────────────────────────────────────
// Prisma error taxonomy (prisma.io/docs/orm/reference/error-reference):
//   P2002 — unique constraint violation (expected CashMovement dedup)
//   P2025 — record not found (expected when intent vanishes between read+write)
//   anything else — unexpected / terminal; must be audited before re-throw
export function classifyBatchError(err: unknown): {
  isKnownRequest: boolean;
  isUniqueViolation: boolean;
  isRecordNotFound: boolean;
} {
  const isKnownRequest = err instanceof Prisma.PrismaClientKnownRequestError;
  return {
    isKnownRequest,
    isUniqueViolation: isKnownRequest && err.code === "P2002",
    isRecordNotFound: isKnownRequest && err.code === "P2025",
  };
}

// ── ITEM 2: Dedup metric log ───────────────────────────────────────────────
// Promoted to WARNING (from INFO) so the log-based metric filter
// `severity>=WARNING AND jsonPayload.action="MP_CONFIRM_DUPLICATE_CASH_BLOCKED_BY_CONSTRAINT"`
// captures it. A spike signals a retry storm.
// Ref: cloud.google.com/logging/docs/logs-based-metrics
export function logDedupHit(
  businessId: string,
  paymentIntentId: string,
  saleId: string | null,
  monto: number,
  constraintTarget: unknown,
): void {
  cloudLog({
    severity: "WARNING",
    message: "MP_CONFIRM_DUPLICATE_CASH_BLOCKED_BY_CONSTRAINT",
    component: "Payments",
    action: "MP_CONFIRM_DUPLICATE_CASH_BLOCKED_BY_CONSTRAINT",
    a2a_transfer: false,
    businessId,
    "logging.googleapis.com/labels": { paymentIntentId, businessId },
    data: { saleId, paymentIntentId, monto, constraint: constraintTarget },
  });
}

// ── ITEM 1: DLQ observability — CriticalWriteEvent on permanent failure ────
// Fire-and-forget (void): caller throws immediately after; audit write must
// not block the re-throw. Cloud Tasks retries; DLQ captures the task after
// max_attempts. This event makes the audit trail show the failed attempt.
// Ref: stripe.com/docs/error-handling (audit every failed charge attempt)
//      cloud.google.com/tasks/docs/reference/rest/v2/projects.locations.queues.tasks
export function auditBatchFailure(
  businessId: string,
  actorEmployeeId: string | null,
  paymentIntentId: string,
  monto: number,
  err: unknown,
): void {
  const errorMessage = err instanceof Error ? err.message : String(err);
  void recordCriticalWriteEvent({
    client: prisma,
    businessId,
    actorUserId: actorEmployeeId ?? "system-mp-webhook",
    actorEmployeeId,
    routeScope: "payment-intents/confirm",
    actionType: "MP_CONFIRM_BATCH_FAILED",
    resourceType: "payment_intent",
    resourceId: paymentIntentId,
    summary: `MP confirm batch failed — intent ${paymentIntentId}`,
    payload: { paymentIntentId, monto, error: errorMessage },
  });
}

// ── ITEM 3: Race observability — PI state-machine race ────────────────────
// piUpdateMany.count === 0 → concurrent confirm won the race.
// Expected: very rare. Spike suggests retry storm or broken upstream idempotency.
// Ref: brandur.org/idempotency-keys (concurrent confirmation race patterns)
export function logPiRaceLost(businessId: string, paymentIntentId: string): void {
  cloudLog({
    severity: "WARNING",
    message: "MP_CONFIRM_STATE_RACE_LOST",
    component: "Payments",
    action: "MP_CONFIRM_STATE_RACE_LOST",
    a2a_transfer: false,
    businessId,
    "logging.googleapis.com/labels": { paymentIntentId, businessId },
    data: { paymentIntentId },
  });
}

// ── ITEM 4: Sale race observability ───────────────────────────────────────
// saleUpdateMany.count === 0 → sale already paid by a concurrent path.
// Non-fatal: cash movement still committed, PI still confirmed.
export function logSaleRaceLost(
  businessId: string,
  paymentIntentId: string,
  saleId: string,
): void {
  cloudLog({
    severity: "WARNING",
    message: "MP_CONFIRM_SALE_RACE_LOST",
    component: "Payments",
    action: "MP_CONFIRM_SALE_RACE_LOST",
    a2a_transfer: false,
    businessId,
    "logging.googleapis.com/labels": { paymentIntentId, saleId, businessId },
    data: { paymentIntentId, saleId },
  });
}
