// Helpers shared by the event-retry cron (Branch B — standard EmployeeEvent).
// Extracted to keep event-retry-cron.ts within the 300-line server/api limit.

import { MAX_RETRIES } from "./post-commit-replay";

/**
 * Maximum number of delivery attempts for a standard EmployeeEvent (Branch B)
 * before the row is moved to "dropped". Matches the post-commit cap (5 attempts)
 * so both paths have consistent exhaustion semantics. LOW_STOCK and other events
 * that can't be delivered after 5 tries are stale — escalate to CRITICAL and drop
 * rather than filling every cron run with noise.
 */
export const MAX_EVENT_RETRIES = MAX_RETRIES; // 5

/**
 * Serialise a caught value to a non-empty, human-readable string.
 * Works for: Error, GoogleError/gRPC StatusError (message may be "undefined
 * undefined: undefined" when gRPC status fields are unset), non-Error throws.
 */
export function serializeError(err: unknown): string {
  if (err == null) return "null or undefined thrown";
  if (!(err instanceof Error)) return String(err) || "unknown non-Error thrown";
  const parts: string[] = [];
  if (err.name && err.name !== "Error") parts.push(err.name);
  if (err.message) parts.push(err.message);
  // gRPC / GoogleError extras — code and details are standard gRPC fields
  const grpc = err as { code?: unknown; details?: unknown };
  if (grpc.code !== undefined) parts.push(`code=${String(grpc.code)}`);
  if (grpc.details) parts.push(`details=${String(grpc.details)}`);
  if (parts.length === 0 && err.stack) {
    // All string fields empty — fall back to first line of stack trace
    return err.stack.split("\n")[0] || "Error (no message)";
  }
  return parts.join(" | ") || "Error (no message)";
}

/** Extract the retry counter stored in errorMessage ("retry[N]: …") or 0. */
export function parseRetryCount(errorMessage: string | null | undefined): number {
  if (!errorMessage) return 0;
  const m = errorMessage.match(/^retry\[(\d+)\]:/);
  return m ? parseInt(m[1], 10) : 0;
}
