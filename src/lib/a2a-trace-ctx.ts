// a2a-trace-ctx.ts — X-Cloud-Trace-Context helper for outbound A2A calls.
//
// Reads the AsyncLocalStorage trace store (set by runWithTraceContext on the
// inbound request) and builds the header value so sub-agent logs are joined
// to the parent span in Cloud Logging.
//
// Format: "{traceId}/{spanId};o={0|1}" — matches what Cloud Run injects on
// inbound requests and what sub-agent routes parse via runWithTraceContext.
//
// Ref: https://cloud.google.com/trace/docs/setup#force-trace (header format)

import { getTraceStore } from "./cloud-logger";

/**
 * Returns the X-Cloud-Trace-Context header value for the current async context,
 * or undefined when no trace is active. Callers should guard with:
 *   const tc = traceCtxHeader(); if (tc) headers["X-Cloud-Trace-Context"] = tc;
 */
export function traceCtxHeader(): string | undefined {
  const s = getTraceStore();
  const traceId = s?.trace?.split("/traces/")[1];
  if (!traceId) return undefined;
  const spanPart = s?.spanId ? `/${s.spanId}` : "";
  return `${traceId}${spanPart};o=${s?.sampled ? 1 : 0}`;
}
