import { randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";

type CriticalWriteEventDelegate = {
  create(args: {
    data: {
      id: string;
      businessId: string;
      actorUserId: string;
      actorEmployeeId?: string | null;
      routeScope: string;
      actionType: string;
      resourceType: string;
      resourceId: string | null;
      summary: string;
      payloadJson: string;
      inputJson?: string | null;
      beforeJson?: string | null;
      afterJson?: string | null;
      createdAt: Date;
    };
  }): Promise<unknown>;
  deleteMany(args: {
    where: { businessId: string; createdAt: { lt: Date } };
  }): Promise<unknown>;
};

type CriticalWriteClient = {
  criticalWriteEvent: CriticalWriteEventDelegate;
};

// PII redaction: el payloadJson queda en DB indefinidamente (90d retención),
// y se replica a logs cuando algo falla. No queremos guardar phone/email/PIN
// en claro — el hash basta para audit (¿este actor hizo X?), no para
// reidentificar.
//
// redactPiiString cubre el campo `.summary`, que es texto libre y puede
// llevar nombre/teléfono/email de un cliente si el llamador lo interpola
// directamente (e.g. "Venta deshecha — Juan Pérez"). Mismas reglas que
// chat-history-redact pero independiente para evitar acoplamiento de módulo.
const PII_KEY_PATTERN = /^(pin|password|secret|token|apikey|api_key|whatsapp|whatsappnumber|phone|phonenumber|telefono|tel|cell|mobile|email|mail|correo|dni|cuit|cuil|address|direccion|street|streetaddress|otp|verification_code|vapid|webpush)$/i;

// Patterns for free-text PII scrubbing in summary strings.
const SUMMARY_EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g;
const SUMMARY_AR_PHONE_RE = /\+?54\s?9?\s?\d{1,4}\s?\d{3,4}\s?\d{3,5}/g;
// Generic phone: 8–15 contiguous digits, optionally separated by spaces/dashes.
// Negative lookbehind prevents redacting invoice numbers (REC-/FC-/PRES- prefix).
const SUMMARY_PHONE_RE = /(?<!(?:REC|FC|PRES)-)\b\d{2,4}[\s-]?\d{3,4}[\s-]?\d{4}\b/g;
const SUMMARY_CUIT_RE = /(?<!(?:REC|FC|PRES)-)\b\d{2}-?\d{7,8}-?\d\b/g;

/**
 * Redact PII tokens from a free-text summary string.
 * Preserves businessId-like UUIDs, amounts ($1234), and action descriptors.
 */
export function redactPiiString(text: string): string {
  return text
    .replace(SUMMARY_EMAIL_RE, "[email]")
    .replace(SUMMARY_AR_PHONE_RE, "[tel]")
    .replace(SUMMARY_CUIT_RE, "[cuit]")
    .replace(SUMMARY_PHONE_RE, "[tel]");
}

function redactValue(v: unknown): unknown {
  if (typeof v === "string") {
    if (v.length === 0) return v;
    if (v.length <= 4) return "***";
    return `${v.slice(0, 2)}***${v.slice(-2)}`;
  }
  return "***";
}

function redactPii(value: unknown, depth = 0): unknown {
  if (depth > 6) return value; // safety: avoid pathological nesting blowup
  if (Array.isArray(value)) return value.map((v) => redactPii(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (PII_KEY_PATTERN.test(k)) {
        out[k] = redactValue(v);
      } else {
        out[k] = redactPii(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

function toPayloadJson(payload: unknown) {
  return JSON.stringify(redactPii(payload));
}

/**
 * Records a critical write event to the audit trail.
 * Never throws — retries once on failure and logs errors to stderr.
 * Returns `true` if the trace was persisted, `false` if both attempts failed.
 * Callers should `await` this so the write completes before responding.
 */
export async function recordCriticalWriteEvent(args: {
  client: CriticalWriteClient;
  businessId: string;
  actorUserId: string;
  /** Employee actor cuando la mutación viene del flujo PIN, null cuando el owner actuó directo. */
  actorEmployeeId?: string | null;
  routeScope: string;
  actionType: string;
  resourceType: string;
  resourceId?: string | null;
  summary: string;
  payload: unknown;
  /** Optional diff context — absorbed from the former AuditLog (2026-05-16). */
  input?: unknown;
  before?: unknown;
  after?: unknown;
}): Promise<boolean> {
  const {
    client,
    businessId,
    actorUserId,
    actorEmployeeId = null,
    routeScope,
    actionType,
    resourceType,
    resourceId = null,
    summary,
    payload,
    input,
    before,
    after,
  } = args;

  const data = {
    id: randomUUID().replace(/-/g, ""),
    businessId,
    actorUserId,
    actorEmployeeId,
    routeScope,
    actionType,
    resourceType,
    resourceId,
    summary: redactPiiString(summary),
    payloadJson: toPayloadJson(payload),
    inputJson: input !== undefined ? JSON.stringify(redactPii(input)) : null,
    beforeJson: before !== undefined ? JSON.stringify(redactPii(before)) : null,
    afterJson: after !== undefined ? JSON.stringify(redactPii(after)) : null,
    createdAt: new Date(),
  };

  // 90-day cleanup ahora vive en /api/scheduled/audit-cleanup (cron diario).
  // El patrón probabilístico previo skewaba hacia hot paths y era no-determinístico.

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Generate fresh ID on retry to avoid unique constraint collision
      // if the first attempt persisted but the network response was lost
      if (attempt > 0) data.id = randomUUID().replace(/-/g, "");
      await client.criticalWriteEvent.create({ data });
      return true;
    } catch (error) {
      if (attempt === 0) continue;
      cloudLog({ severity: "CRITICAL", component: "System", action: "CRITICAL_WRITE_AUDIT_FAILED", a2a_transfer: false, message: `critical-write-audit FAILED after 2 attempts — ${actionType}`, data: { actionType, resourceId: resourceId ?? null, error: error instanceof Error ? error.message : String(error) } });
    }
  }
  return false;
}
