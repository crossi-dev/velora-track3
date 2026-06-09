import { randomUUID } from "crypto";

/**
 * Mutation Trace — lightweight end-to-end tracing for business mutations.
 *
 * Every important mutation gets a single traceId that follows it from
 * API route → validation → DB write → audit trail → response.
 * In development, trace data is included in the response for debugging.
 * In production, traceId is logged but not exposed to the client.
 *
 * Inspired by OpenTelemetry's trace model: one operation, one ID,
 * multiple spans across layers.
 */

export interface MutationTraceSpan {
  name: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface MutationTrace {
  traceId: string;
  action: string;
  startedAt: number;
  spans: MutationTraceSpan[];

  /** Add a span to the trace */
  span: (name: string, metadata?: Record<string, unknown>) => void;

  /** Mark a span with duration (call at end of a measured section) */
  endSpan: (name: string) => void;

  /** Get trace data for logging or response inclusion */
  toLog: () => { traceId: string; action: string; totalMs: number; spans: string[] };

  /** Get trace data for response (dev-only, null in production) */
  toResponse: () => Record<string, unknown> | null;
}

const IS_DEV = process.env.NODE_ENV === "development";

const activeSpanStarts = new Map<string, number>();

export function createMutationTrace(action: string): MutationTrace {
  const traceId = randomUUID().replace(/-/g, "").slice(0, 16);
  const startedAt = Date.now();
  const spans: MutationTraceSpan[] = [];

  return {
    traceId,
    action,
    startedAt,
    spans,

    span(name: string, metadata?: Record<string, unknown>) {
      activeSpanStarts.set(`${traceId}:${name}`, Date.now());
      spans.push({ name, metadata });
    },

    endSpan(name: string) {
      const key = `${traceId}:${name}`;
      const start = activeSpanStarts.get(key);
      if (start) {
        const span = spans.find((s) => s.name === name && !s.durationMs);
        if (span) span.durationMs = Date.now() - start;
        activeSpanStarts.delete(key);
      }
    },

    toLog() {
      return {
        traceId,
        action,
        totalMs: Date.now() - startedAt,
        spans: spans.map((s) => `${s.name}${s.durationMs != null ? ` (${s.durationMs}ms)` : ""}`),
      };
    },

    toResponse() {
      if (!IS_DEV) return null;
      return {
        _traceId: traceId,
        _traceAction: action,
        _traceMs: Date.now() - startedAt,
        _traceSpans: spans.map((s) => ({
          name: s.name,
          ...(s.durationMs != null ? { ms: s.durationMs } : {}),
          ...(s.metadata ? { meta: s.metadata } : {}),
        })),
      };
    },
  };
}
