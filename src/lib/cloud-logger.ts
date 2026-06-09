// Google Cloud Structured Logging — single-line JSON to stdout; Cloud Run
// auto-parses as Cloud Logging entries.
// Promoted fields: severity, message, time (RFC 3339), httpRequest,
//   logging.googleapis.com/{trace,spanId,trace_sampled,labels,operation,
//   sourceLocation,insertId}.
// Custom fields (component, action, a2a_transfer, data, businessId, eventId)
// stay in jsonPayload — filterable via `jsonPayload.component="Supervisor"`.
// ERROR + stack trace → auto-forwarded to Cloud Error Reporting (no SDK needed).
// Ref: https://cloud.google.com/logging/docs/structured-logging#special-payload-fields

import { AsyncLocalStorage } from "node:async_hooks";

export type CloudLogSeverity =
  | "DEBUG"
  | "INFO"
  | "NOTICE"
  | "WARNING"
  | "ERROR"
  | "CRITICAL";

export type CloudLogComponent =
  | "Employee"
  | "Companion"
  | "Supervisor"
  | "Owner"
  | "RBAC"
  | "System"
  | "Feedback"
  | "FewShot"
  | "A2A"
  | "SaleHandler"
  | "SaleExecutor"
  | "EmployeeHandler"
  | "Payments"
  | "Fiscal"
  | "Andreani"
  | "OnboardingAgent"
  | "OnboardingTools"
  | "Communications"
  | "Auth"
  | "Security"
  | "CustomerAgent"
  | "WhatsApp"
  | "OwnerAssistant";

export interface CloudLogEntry {
  severity: CloudLogSeverity;
  message: string;
  component: CloudLogComponent;
  action: string;
  a2a_transfer: boolean;
  /**
   * RFC 3339 timestamp. Cloud Logging auto-promotes this field to the
   * LogEntry.timestamp top-level field. Field MUST be named "time" —
   * "timestamp" is NOT a special field and stays buried in jsonPayload.
   */
  time?: string;
  data?: Record<string, unknown>;
  businessId?: string;
  eventId?: string;
  actorUserId?: string;
  actorEmployeeId?: string;
  /**
   * Top-level stack trace string. Cloud Error Reporting checks this field
   * first (before `exception` and `message`) to detect and group error events.
   * Must be at the root of jsonPayload — nested inside `data` is invisible to
   * Error Reporting. Set by `reportError()` when an Error has a stack.
   */
  stack_trace?: string;
  /**
   * Cloud Trace correlation. When set as `projects/<id>/traces/<trace-id>`,
   * Cloud Logging links the entry to its trace in Cloud Trace and shows
   * the latency timeline next to the log line. Populated automatically
   * by `withTraceContext` from the X-Cloud-Trace-Context request header.
   */
  "logging.googleapis.com/trace"?: string;
  /** Span ID from the request's trace context. Helps Cloud Trace nest spans. */
  "logging.googleapis.com/spanId"?: string;
  /** True when the trace should be sampled (forwarded to Cloud Trace). */
  "logging.googleapis.com/trace_sampled"?: boolean;
  /**
   * Key/value labels promoted to the LogEntry.labels top-level map.
   * Use for fields that need to power log-based metrics or label filters
   * in Cloud Logging (e.g. `{ "businessId": "biz_123", "env": "prod" }`).
   * Values must be strings.
   */
  "logging.googleapis.com/labels"?: Record<string, string>;
}

const PROJECT_ID = process.env.GCP_PROJECT_ID || "my-gcp-project";

/**
 * Parse the `X-Cloud-Trace-Context` header that Cloud Run injects on every
 * request. Format: `TRACE_ID/SPAN_ID;o=SAMPLED` where TRACE_ID is 32-hex
 * and SPAN_ID is decimal. Returns the canonical Cloud Logging fields that
 * link a log entry to its trace.
 *
 * Closes the distributed tracing gap from PHASE2_7_REAUDIT.md (Phase 5+7
 * → 10) without pulling in @opentelemetry/sdk-node — Cloud Run already
 * propagates the header; we just have to surface it in our structured logs.
 */
export function traceFieldsFromHeaders(
  headers: Headers | { get: (name: string) => string | null },
): Pick<
  CloudLogEntry,
  "logging.googleapis.com/trace" | "logging.googleapis.com/spanId" | "logging.googleapis.com/trace_sampled"
> {
  const raw = typeof headers.get === "function" ? headers.get("x-cloud-trace-context") : null;
  if (!raw) return {};
  const [traceAndSpan, opts] = raw.split(";");
  const [traceId, spanId] = (traceAndSpan || "").split("/");
  if (!traceId) return {};
  const sampled = !!opts && /o=1/.test(opts);
  return {
    "logging.googleapis.com/trace": `projects/${PROJECT_ID}/traces/${traceId}`,
    ...(spanId ? { "logging.googleapis.com/spanId": spanId } : {}),
    "logging.googleapis.com/trace_sampled": sampled,
  };
}

/**
 * Emite un log JSON estructurado a stdout. Cloud Run lo levanta y lo
 * indexa en Cloud Logging. Una sola línea por entry — newline embebida en
 * `data` se serializa como `\n`, no rompe el parser.
 *
 * IMPORTANT: usar `console.log` para entries severidad ≤ NOTICE; para
 * WARNING+ algunos runtimes capturan stderr separado, así que `console.warn`
 * y `console.error` también disparan según la severity.
 */
// AsyncLocalStorage propagates trace context across awaits within a request
// without threading the request object through every helper. Set once at
// the top of a route handler via `runWithTraceContext(req, async () => {...})`.

interface TraceStore {
  trace?: string;
  spanId?: string;
  sampled?: boolean;
}

const traceContextStorage = new AsyncLocalStorage<TraceStore>();

export function runWithTraceContext<T>(
  headers: Headers | { get: (name: string) => string | null } | null,
  fn: () => T,
): T {
  if (!headers) return fn();
  const fields = traceFieldsFromHeaders(headers);
  const store: TraceStore = {
    trace: fields["logging.googleapis.com/trace"],
    spanId: fields["logging.googleapis.com/spanId"],
    sampled: fields["logging.googleapis.com/trace_sampled"],
  };
  return traceContextStorage.run(store, fn);
}

/** Snapshot trace store for re-entry in fire-and-forget async continuations. */
export function getTraceStore(): TraceStore | undefined {
  return traceContextStorage.getStore();
}

/** Re-enter a snapshotted trace store in a new async scope. Noop if undefined. */
export function runWithTraceStore<T>(store: TraceStore | undefined, fn: () => T): T {
  if (!store) return fn();
  return traceContextStorage.run(store, fn);
}

export function cloudLog(entry: CloudLogEntry): void {
  const store = traceContextStorage.getStore();
  const full: CloudLogEntry = {
    ...entry,
    // "time" is the Cloud Logging special field for timestamp promotion.
    // Using "timestamp" here would leave it inside jsonPayload unindexed.
    time: entry.time ?? new Date().toISOString(),
    ...(store?.trace ? { "logging.googleapis.com/trace": store.trace } : {}),
    ...(store?.spanId ? { "logging.googleapis.com/spanId": store.spanId } : {}),
    ...(store?.sampled !== undefined ? { "logging.googleapis.com/trace_sampled": store.sampled } : {}),
  };
  const serialized = JSON.stringify(full);
  if (entry.severity === "ERROR" || entry.severity === "CRITICAL") {
    console.error(serialized);
    return;
  }
  if (entry.severity === "WARNING") {
    console.warn(serialized);
    return;
  }
  console.log(serialized);
}

interface A2ATransferArgs {
  source: CloudLogComponent;
  destination: CloudLogComponent;
  action: string;
  message: string;
  data?: Record<string, unknown>;
  businessId?: string;
  eventId?: string;
  actorUserId?: string;
  actorEmployeeId?: string;
}

/**
 * Helper para auditar transferencias A2A. Siempre emite severity INFO +
 * a2a_transfer: true. El `component` se setea al source (quién emite el
 * mensaje); destination viaja como label en `data`.
 *
 * Ejemplo de uso (Empleado publica LOW_STOCK al Supervisor):
 *   logA2ATransfer({
 *     source: "Employee",
 *     destination: "Supervisor",
 *     action: "SALE_REPORT",
 *     message: "Empleado registró venta — publica LOW_STOCK",
 *     data: { saleId, alerts: [...] },
 *     businessId,
 *     eventId,
 *   });
 */
export function logA2ATransfer(args: A2ATransferArgs): void {
  cloudLog({
    severity: "INFO",
    component: args.source,
    action: args.action,
    a2a_transfer: true,
    message: `${args.message} → ${args.destination}`,
    data: {
      source: args.source,
      destination: args.destination,
      ...(args.data ?? {}),
    },
    businessId: args.businessId,
    eventId: args.eventId,
    actorUserId: args.actorUserId,
    actorEmployeeId: args.actorEmployeeId,
  });
}

interface UnauthorizedAccessArgs {
  attemptedAction: string;
  actorRole: string;
  endpoint?: string;
  businessId?: string;
  actorEmployeeId?: string;
}

/**
 * Helper para auditar intentos de empleados de ejecutar acciones owner-only.
 * Siempre WARNING + action: UNAUTHORIZED_ACCESS. Útil para detectar tanto
 * bugs (un cliente que pega al endpoint equivocado) como abuso real
 * (cookie de empleado robada). Cloud Logging permite hacer alertas sobre
 * spike de UNAUTHORIZED_ACCESS por businessId.
 */
export function logUnauthorizedAccess(args: UnauthorizedAccessArgs): void {
  cloudLog({
    severity: "WARNING",
    component: "RBAC",
    action: "UNAUTHORIZED_ACCESS",
    a2a_transfer: false,
    message: `Acción owner-only intentada por ${args.actorRole}: ${args.attemptedAction}`,
    data: {
      attemptedAction: args.attemptedAction,
      actorRole: args.actorRole,
      endpoint: args.endpoint,
    },
    businessId: args.businessId,
    actorEmployeeId: args.actorEmployeeId,
  });
}

// reportError and reportWarning live in cloud-logger-error.ts (split to stay
// under the 300-line server/lib cap). Re-exported here for backward compat.
export { reportError, reportWarning } from "@/lib/cloud-logger-error";
