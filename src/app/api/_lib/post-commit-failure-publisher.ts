import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

// Publishes a post-commit action failure to AgentEventLog so the event-retry
// cron can pick it up and replay with exponential backoff.
//
// Schema note: AgentEventLog has no retries/nextAttemptAt columns. We store
// the retry counter inside payloadJson under the "retries" key. The cron
// reads it, increments it, and uses processedAt as the "last attempt at"
// timestamp to gate the next attempt.
//
// Backoff curve (5 attempts max):
//   attempt 1 → 1 min cooldown
//   attempt 2 → 5 min
//   attempt 3 → 15 min
//   attempt 4 → 1 h
//   attempt 5 → 6 h
// After attempt 5 fails, status is set to "dropped" and a CRITICAL log fires.
//
// eventId scheme: `post-commit-${action}-${saleId|no-sale}`.
// If the same (action, saleId) fails again before the cron retries it, the
// upsert is a no-op (unique constraint returns P2002) so we don't reset the
// retry counter.

export interface PostCommitPayload {
  action: string;
  saleId: string | null | undefined;
  errorMessage: string;
  /** Extra context captured at failure time (invoiceId, etc.) */
  originalArgs?: Record<string, unknown>;
  retries: number;
}

export const POST_COMMIT_PROTOCOL = "post-commit-action-failed";
export const POST_COMMIT_PROTOCOL_VERSION = "1.0";

/**
 * Finding #3: original scheme used saleId|"no-sale" — two concurrent
 * saleId=null failures for the same action silently dropped the second
 * retry row via P2002. Include paymentIntentId as tiebreaker.
 * Ref: brandur.org/idempotency-keys (2026).
 */
export function buildPostCommitEventId(
  action: string,
  saleId: string | null | undefined,
  paymentIntentId?: string | null,
): string {
  const qualifier = saleId ?? paymentIntentId ?? "no-id";
  return `post-commit-${action}-${qualifier}`;
}

export async function publishPostCommitFailure({
  businessId,
  saleId,
  action,
  errorMessage,
  originalArgs,
}: {
  businessId: string;
  saleId?: string | null;
  action: string;
  errorMessage: string;
  originalArgs?: Record<string, unknown>;
}): Promise<void> {
  // Finding #3: pass paymentIntentId from originalArgs as tiebreaker when saleId=null.
  const piId = typeof originalArgs?.paymentIntentId === "string" ? originalArgs.paymentIntentId : null;
  const eventId = buildPostCommitEventId(action, saleId, piId);
  const payload: PostCommitPayload = {
    action,
    saleId: saleId ?? null,
    errorMessage,
    originalArgs,
    retries: 0,
  };

  try {
    await prisma.agentEventLog.create({
      data: {
        businessId,
        eventId,
        protocol: POST_COMMIT_PROTOCOL,
        protocolVersion: POST_COMMIT_PROTOCOL_VERSION,
        eventType: action,
        source: "system",
        destination: "event-retry-cron",
        payloadJson: JSON.stringify(payload),
        status: "pending",
      },
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    // P2002: a retry row for this (action, saleId) already exists — don't reset it.
    if (code === "P2002") return;
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "POST_COMMIT_FAILURE_PUBLISH_FAILED",
      a2a_transfer: false,
      message: "could not write post-commit failure to AgentEventLog",
      businessId,
      data: { saleId, action, error: err instanceof Error ? err.message : String(err) },
    });
  }
}
