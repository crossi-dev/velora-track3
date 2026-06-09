// Cloud Error Reporting helpers — extracted from cloud-logger.ts to stay under
// the 300-line server/lib cap. Import from here when you need reportError or
// reportWarning; everything else (cloudLog, logA2ATransfer, runWithTraceContext)
// stays in cloud-logger.ts.

import { cloudLog } from "@/lib/cloud-logger";

/**
 * Report an error to Cloud Error Reporting via Cloud Logging.
 *
 * Cloud Run auto-forwards log entries with severity=ERROR and a stack trace
 * to Cloud Error Reporting — no SDK needed.
 *
 * `stack_trace` is emitted at root level (required — nested in `data` is
 * invisible to Error Reporting auto-grouping).
 */
export function reportError(error: unknown, context?: Record<string, unknown>): void {
  const err = error instanceof Error ? error : new Error(String(error));
  cloudLog({
    severity: "ERROR",
    component: "System",
    action: "UNHANDLED_ERROR",
    a2a_transfer: false,
    message: err.message,
    // stack_trace at root level — Cloud Error Reporting requires this field at
    // the jsonPayload root to auto-group errors. Nested inside `data` is invisible.
    stack_trace: err.stack ?? undefined,
    data: {
      errorName: err.name,
      ...context,
    },
  });
}

/**
 * Report a warning-level event to Cloud Logging. Does not trigger Cloud Error
 * Reporting auto-forward (requires ERROR severity), but is searchable in Cloud Logging.
 */
export function reportWarning(message: string, context?: Record<string, unknown>): void {
  cloudLog({
    severity: "WARNING",
    component: "System",
    action: "WARNING_EVENT",
    a2a_transfer: false,
    message,
    data: context,
  });
}
