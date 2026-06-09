// Transport abstraction para el bus A2A. Decouples publisher from underlying
// transport (loopback HTTP vs Pub/Sub) — selectable via env.
//
// Por qué la abstracción:
//   - Local dev: no GCP creds, no topic. Loopback HTTP al mismo proceso
//     funciona y es debuggable con curl.
//   - Producción Cloud Run: Pub/Sub. Fire-and-forget real (publish retorna
//     en ms), backpressure manejado por Google, dead-letter para retries
//     que exhausten.
//   - Tests: TestTransport que captura los mensajes en memoria, sin HTTP.
//
// La selección es por env `A2A_TRANSPORT`:
//   - "pubsub"  → PubSubTransport
//   - "loopback" (default) → LoopbackTransport
//
// El payload publicado es siempre el `EmployeeEvent` typed (definido en
// agent-contract.ts). El transport sólo se ocupa del "cómo viaja"; la
// semántica + idempotencia + audit log siguen viviendo en agent-events.ts.

import type { EmployeeEvent } from "./agent-contract";
import { formatEventTextSummary, EMPLOYEE_EVENT_PROTOCOL } from "./agent-contract";
import type { SupervisorNotification } from "./supervisor-types";
import { sendMessage } from "./a2a-client";
import { cloudLog } from "./cloud-logger";
import { A2A_TRANSPORT_DEFAULT_TIMEOUT_MS } from "./agent-timeouts";

class TransportConfigError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "TransportConfigError";
  }
}

const PUBSUB_TOPIC = process.env.PUBSUB_A2A_TOPIC ?? "velora-a2a-events";

export interface StockIngressDecision {
  approved: boolean;
  anomaly: boolean;
  reason: string;
}

export interface A2APublishResult {
  /** ID del mensaje según el transport (Pub/Sub messageId o A2A messageId). */
  messageId: string;
  /** Decisión inmediata del Supervisor (sólo loopback — Pub/Sub es async). */
  notification?: SupervisorNotification | null;
  /** Decisión del Supervisor para STOCK_INGRESS_REQUEST (aprobado/anomalía). */
  stockIngressDecision?: StockIngressDecision | null;
}

export interface A2ATransport {
  publish(event: EmployeeEvent, opts?: TransportOptions): Promise<A2APublishResult>;
}

export interface TransportOptions {
  /** Override URL para loopback en tests. Ignorado por Pub/Sub. */
  agentUrl?: string;
  apiKey?: string;
  /** Timeout en ms. Loopback usa este; Pub/Sub usa el del SDK. */
  timeoutMs?: number;
}

// ── Loopback HTTP transport ──────────────────────────────────────────────

class LoopbackTransport implements A2ATransport {
  async publish(event: EmployeeEvent, opts: TransportOptions = {}): Promise<A2APublishResult> {
    const apiKey = opts.apiKey ?? process.env.A2A_API_KEY;
    if (!apiKey) {
      throw new TransportConfigError("loopback transport requires A2A_API_KEY", "no_api_key");
    }
    const baseUrl = opts.agentUrl ?? resolveOwnAppUrl();
    if (!baseUrl) {
      throw new TransportConfigError("loopback transport could not resolve app URL", "no_app_url");
    }
    const text = buildAgentText(event);
    const reply = await sendMessage(`${baseUrl}/api/a2a/jsonrpc`, text, {
      apiKey,
      timeoutMs: opts.timeoutMs ?? A2A_TRANSPORT_DEFAULT_TIMEOUT_MS,
    });
    return {
      messageId: reply.messageId,
      notification: extractNotificationFromDataParts(reply.dataParts),
      stockIngressDecision: extractStockIngressDecisionFromDataParts(reply.dataParts),
    };
  }
}

// ── Google Cloud Pub/Sub transport ───────────────────────────────────────
//
// Se inicializa lazy: el SDK abre conexiones gRPC en el constructor del
// PubSub client, costoso si nunca se usa. Cargamos al primer publish.

let cachedPubsubClient: import("@google-cloud/pubsub").PubSub | null = null;

async function getPubsubClient(): Promise<import("@google-cloud/pubsub").PubSub> {
  if (cachedPubsubClient) return cachedPubsubClient;
  const { PubSub } = await import("@google-cloud/pubsub");
  cachedPubsubClient = new PubSub();
  return cachedPubsubClient;
}

class PubSubTransport implements A2ATransport {
  async publish(event: EmployeeEvent): Promise<A2APublishResult> {
    const pubsub = await getPubsubClient();
    // El SDK ya hace retry interno para gRPC codes UNAVAILABLE (14),
    // DEADLINE_EXCEEDED (4), INTERNAL (13), RESOURCE_EXHAUSTED (8), ABORTED (10)
    // según la retry config default. NO envolver en nuestro try/catch para
    // republish — duplicaríamos retries. Solo capturar y propagar permanent
    // errors (PERMISSION_DENIED, INVALID_ARGUMENT, NOT_FOUND).
    const topic = pubsub.topic(PUBSUB_TOPIC);
    const messageId = await topic.publishMessage({
      json: event,
      attributes: {
        protocol: event.protocol,
        protocolVersion: event.protocolVersion,
        eventType: event.type,
        businessId: event.businessId,
        eventId: event.eventId,
      },
    });
    // Pub/Sub es async — la decisión del supervisor llega después al
    // pubsub-handler endpoint. Aquí retornamos sin notification.
    return { messageId, notification: null };
  }
}

// ── Test transport (test-infrastructure export) ──────────────────────────

/**
 * In-memory transport for unit tests. Captures all published events without
 * making any HTTP or Pub/Sub calls.
 */
export class TestTransport implements A2ATransport {
  public published: EmployeeEvent[] = [];
  private _reply: A2APublishResult | null = null;

  setReply(reply: A2APublishResult): void {
    this._reply = reply;
  }

  reset(): void {
    this.published = [];
    this._reply = null;
  }

  async publish(event: EmployeeEvent): Promise<A2APublishResult> {
    this.published.push(event);
    if (this._reply) return this._reply;
    return { messageId: `${event.eventId ?? "test"}-${Date.now()}` };
  }
}

// ── Selector ─────────────────────────────────────────────────────────────

export type TransportKind = "loopback" | "pubsub";

export function getActiveTransportKind(): TransportKind {
  const v = process.env.A2A_TRANSPORT?.toLowerCase();
  return v === "pubsub" ? "pubsub" : "loopback";
}

let cachedTransport: A2ATransport | null = null;
let testTransportOverride: A2ATransport | null = null;

/**
 * Inyecta un transport para tests. Pasar null para restablecer.
 * Usado por TestTransport en unit tests.
 */
export function setTransportForTest(transport: A2ATransport | null): void {
  testTransportOverride = transport;
  cachedTransport = null;
}

/**
 * Retorna el transport activo según env. Cacheado por proceso para evitar
 * recrear el cliente Pub/Sub en cada publish. Para tests, usar
 * `setTransportForTest` para inyectar un TestTransport.
 */
export function getA2ATransport(): A2ATransport {
  if (testTransportOverride) return testTransportOverride;
  if (cachedTransport) return cachedTransport;
  const kind = getActiveTransportKind();
  if (process.env.NODE_ENV === "production" && kind !== "pubsub") {
    // Fail-CLOSED, not warn: loopback HTTP on multi-instance Cloud Run causes
    // duplicate-event races + silent drops. Refuse to boot on the unreliable
    // transport in prod — a misconfigured deploy fails loudly instead of running
    // degraded. (A2A_TRANSPORT=pubsub is set in cloudbuild-dockerfile.yaml.)
    cloudLog({
      severity: "CRITICAL",
      component: "System",
      action: "A2A_TRANSPORT_MISCONFIGURED",
      a2a_transfer: false,
      message: "A2A_TRANSPORT must be 'pubsub' in production — refusing loopback.",
      data: { resolvedTransport: kind, expected: "pubsub" },
    });
    throw new Error(
      "A2A_TRANSPORT must be 'pubsub' in production (got loopback). " +
        "Set A2A_TRANSPORT=pubsub in the Cloud Run environment.",
    );
  }
  cachedTransport = kind === "pubsub" ? new PubSubTransport() : new LoopbackTransport();
  return cachedTransport;
}

// ── Helpers privados (ex agent-events.ts) ────────────────────────────────

function resolveOwnAppUrl(): string | null {
  const explicit = process.env.VELORA_APP_URL;
  if (explicit && explicit.startsWith("http")) return explicit.replace(/\/$/, "");
  if (process.env.NODE_ENV !== "production") return "http://localhost:3000";
  return null;
}

function buildAgentText(event: EmployeeEvent): string {
  const summary = formatEventTextSummary(event);
  return [
    "EMPLOYEE_EVENT",
    `protocol: ${event.protocol}`,
    `protocolVersion: ${EMPLOYEE_EVENT_PROTOCOL.version}`,
    `type: ${event.type}`,
    `businessId: ${event.businessId}`,
    `eventId: ${event.eventId}`,
    "---",
    summary,
  ].join("\n");
}

function extractStockIngressDecisionFromDataParts(dataParts: unknown[]): StockIngressDecision | null {
  for (const part of dataParts) {
    if (!part || typeof part !== "object") continue;
    const obj = part as Record<string, unknown>;
    if (obj.contract !== "velora.supervisor.stock_ingress_decision") continue;
    const d = obj.decision;
    if (!d || typeof d !== "object") continue;
    const dec = d as Record<string, unknown>;
    if (typeof dec.approved !== "boolean" || typeof dec.anomaly !== "boolean" || typeof dec.reason !== "string") continue;
    return { approved: dec.approved, anomaly: dec.anomaly, reason: dec.reason };
  }
  return null;
}

function extractNotificationFromDataParts(dataParts: unknown[]): SupervisorNotification | null {
  for (const part of dataParts) {
    if (!part || typeof part !== "object") continue;
    const obj = part as Record<string, unknown>;
    if (obj.contract !== "velora.supervisor.notification") continue;
    const notif = obj.notification;
    if (!notif || typeof notif !== "object") continue;
    const n = notif as Record<string, unknown>;
    if (n.level !== "now" && n.level !== "daily" && n.level !== "drop") continue;
    return {
      level: n.level as SupervisorNotification["level"],
      title: typeof n.title === "string" ? n.title : "",
      body: typeof n.body === "string" ? n.body : "",
      reason: typeof n.reason === "string" ? n.reason : "",
    };
  }
  return null;
}
