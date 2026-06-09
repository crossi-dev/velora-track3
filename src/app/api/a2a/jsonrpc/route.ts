import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { cloudLog, reportError, reportWarning, runWithTraceContext } from "@/lib/cloud-logger";
import { runSupervisor, supervisorAnswer } from "@/app/api/supervisor/_lib/supervisor-runner";
import type { StockIngressDecision } from "@/lib/a2a-transport";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";
import {
  handleA2ARpc,
  checkA2AApiKey,
  rpcError,
  JSON_RPC_ERRORS,
  extractContextIdFromParams,
  extractTextFromParams,
  extractBusinessIdFromText,
  type JsonRpcRequest,
  type SupervisorAdapterResult,
} from "./_lib/handle-rpc";

// ── Session store for multi-turn A2A conversations ───────────────────────────
// In-memory, per-process. Survives within a Cloud Run instance (warm requests).
// TTL = 10 min. Max 500 sessions total; max 10 sessions per businessId (SEC-N-2).
const SESSION_TTL_MS = 10 * 60 * 1000;
const SESSION_MAX = 500;
const SESSION_MAX_PER_TENANT = 10;
interface A2ASession { turns: Array<{ role: "user" | "agent"; text: string }>; updatedAt: number }
const sessionStore = new Map<string, A2ASession>();

// Session keys are namespaced as `${businessId}:${contextId}` when a
// businessId is available (loopback transport always provides one via the
// EMPLOYEE_EVENT text header). For external callers without a businessId the
// key is `anon:${contextId}` — still isolated from tenant-keyed sessions.
function sessionKey(contextId: string, businessId: string | null): string {
  return businessId ? `${businessId}:${contextId}` : `anon:${contextId}`;
}

function getSession(contextId: string, businessId: string | null): A2ASession["turns"] {
  const key = sessionKey(contextId, businessId);
  const s = sessionStore.get(key);
  if (!s || Date.now() - s.updatedAt > SESSION_TTL_MS) { sessionStore.delete(key); return []; }
  return s.turns;
}

function saveSession(contextId: string, businessId: string | null, userText: string, agentText: string): void {
  if (sessionStore.size >= SESSION_MAX) {
    // First pass: evict all TTL-expired entries (O(n), no allocation).
    const now = Date.now();
    for (const [k, v] of sessionStore) {
      if (now - v.updatedAt > SESSION_TTL_MS) sessionStore.delete(k);
    }
    // If still at capacity, evict the single oldest entry (last resort).
    if (sessionStore.size >= SESSION_MAX) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of sessionStore) {
        if (v.updatedAt < oldestTime) { oldestTime = v.updatedAt; oldestKey = k; }
      }
      if (oldestKey !== undefined) sessionStore.delete(oldestKey);
    }
  }
  // SEC-N-2: per-tenant session cap — evict oldest if this businessId exceeds 10 slots.
  if (businessId) {
    const prefix = `${businessId}:`;
    const tenantKeys: [string, number][] = [];
    for (const [k, v] of sessionStore) {
      if (k.startsWith(prefix)) tenantKeys.push([k, v.updatedAt]);
    }
    if (tenantKeys.length >= SESSION_MAX_PER_TENANT) {
      tenantKeys.sort((a, b) => a[1] - b[1]);
      sessionStore.delete(tenantKeys[0][0]);
    }
  }
  const existing = getSession(contextId, businessId);
  const turns = [...existing, { role: "user" as const, text: userText }, { role: "agent" as const, text: agentText }].slice(-6);
  sessionStore.set(sessionKey(contextId, businessId), { turns, updatedAt: Date.now() });
}

export const maxDuration = 40;

// Per-API-key rate limit. Defense in depth on top of checkRateLimit (per-IP).
// An attacker rotating IPs can bypass per-IP limits but cannot generate new
// valid API keys without leaking another. Cap is 60 req/min per key — same
// as the per-IP default, applied independently.
const A2A_KEY_RATE_MAX = 60;
const A2A_KEY_RATE_WINDOW_MS = 60_000;
const A2A_KEY_RATE_MAX_KEYS = 1_000;
const a2aKeyRateMap = new Map<string, number[]>();

function checkA2AKeyRateLimit(apiKey: string): boolean {
  const now = Date.now();
  const cutoff = now - A2A_KEY_RATE_WINDOW_MS;

  // Opportunistic prune at hard cap (cheap; only when full).
  if (a2aKeyRateMap.size > A2A_KEY_RATE_MAX_KEYS) {
    for (const [key, timestamps] of a2aKeyRateMap) {
      if (timestamps.length === 0 || timestamps[timestamps.length - 1] <= cutoff) {
        a2aKeyRateMap.delete(key);
      }
    }
  }

  const timestamps = a2aKeyRateMap.get(apiKey) ?? [];
  const recent = timestamps.filter((t) => t > cutoff);
  recent.push(now);
  a2aKeyRateMap.set(apiKey, recent);
  return recent.length <= A2A_KEY_RATE_MAX;
}

// A2A v0.3.0 JSON-RPC endpoint.
// Wraps the pure handler in handle-rpc.ts with:
//   - Next.js NextRequest/NextResponse plumbing
//   - Rate limiting (shared with the rest of /api/*)
//   - X-API-Key auth
//   - Supervisor adapter (runSupervisor + supervisorAnswer)

const json = (body: unknown) => NextResponse.json(body, { status: 200 });

function buildTextWithHistory(text: string, history: A2ASession["turns"]): string {
  if (history.length === 0) return text;
  const ctx = history.map((t) => `${t.role === "user" ? "usuario" : "velora"}: ${t.text}`).join("\n");
  return `[CONTEXTO CONVERSACIONAL]\n${ctx}\n[FIN CONTEXTO]\n${text}`;
}

async function supervisorAdapter(text: string, history: A2ASession["turns"] = []): Promise<SupervisorAdapterResult> {
  const enrichedText = buildTextWithHistory(text, history);
  const isStockIngress = enrichedText.includes("type: STOCK_INGRESS_REQUEST");
  const sup = await runSupervisor(enrichedText);

  if (isStockIngress) {
    const approved = sup?.kind === "actions";
    const anomaly = sup?.kind === "notification";
    const reason = sup?.notification?.body ?? sup?.actions?.[0]?.summary ?? (approved ? "aprobado" : "anomalía detectada");
    const decision: StockIngressDecision = { approved, anomaly, reason };
    return {
      text: approved ? "[stock_ingress approved]" : `[stock_ingress anomaly] ${sup?.notification?.title ?? ""}`,
      data: {
        contract: "velora.supervisor.stock_ingress_decision",
        contractVersion: "1.0.0",
        decision,
        usedModel: sup?.usedModel,
      },
    };
  }

  if (sup && sup.kind === "notification" && sup.notification) {
    return {
      text: `[notification level=${sup.notification.level}] ${sup.notification.title}`,
      data: {
        contract: "velora.supervisor.notification",
        contractVersion: "1.0.0",
        notification: sup.notification,
        usedModel: sup.usedModel,
      },
    };
  }
  // A2A path is server-to-server: chips are a UI affordance, not needed here.
  return supervisorAnswer(sup, text).text;
}

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  // Parse body before auth so we can extract businessId for per-tenant key
  // validation. A parse failure is reported as PARSE_ERROR without auth
  // context — safe because no sensitive data is returned in that branch.
  let body: JsonRpcRequest;
  try {
    body = (await req.json()) as JsonRpcRequest;
  } catch {
    return json(rpcError(null, JSON_RPC_ERRORS.PARSE_ERROR));
  }

  // Extract businessId from the structured EMPLOYEE_EVENT text payload so we
  // can (a) pick the correct per-tenant API key and (b) namespace the session.
  const rawText = extractTextFromParams(body.params);
  const rawBusinessId = rawText ? extractBusinessIdFromText(rawText) : null;
  // Validate format to prevent namespace injection via crafted text payloads.
  // A valid Prisma CUID is 25 lowercase alphanumeric chars; allow 20-30 for tolerance.
  // Underscores allowed: test fixtures and prefixed IDs use underscore separators.
  // The HMAC key check below is the real security gate; this regex only guards
  // against path-traversal and non-printable chars.
  const businessId = rawBusinessId && /^[a-z0-9_]{20,30}$/.test(rawBusinessId) ? rawBusinessId : null;

  // Per-tenant key check: prefers A2A_API_KEY_<BUSINESS_ID> when available,
  // falls back to global A2A_API_KEY (backward-compatible).
  const providedKey = req.headers.get("x-api-key");
  // Key validation: HMAC-SHA256(A2A_SECRET, businessId). No global fallback.
  if (!checkA2AApiKey(providedKey, process.env.A2A_SECRET, businessId)) {
    return json(rpcError(null, JSON_RPC_ERRORS.AUTH_REQUIRED, "Missing or invalid X-API-Key header"));
  }

  // Narrow providedKey to string — checkA2AApiKey returns true only when non-null.
  // Safe: the early-return above guarantees we only reach this line with a valid key.
  const validatedKey: string = providedKey!; // guaranteed by checkA2AApiKey above

  // Audit every authenticated A2A call.
  // Security model: A2A callers are treated as owner-tier (canRoleExecuteIntent not
  // enforced here — this is a server-to-server path, not an employee session).
  // The supervisor is read-only (returns recommendations; mutations go through
  // their own auth-gated endpoints). Key is per-tenant; global key is rejected
  // for tenant-scoped requests (see checkA2AApiKey).
  cloudLog({
    severity: "INFO", component: "A2A", action: "A2A_REQUEST",
    a2a_transfer: true, message: "a2a.jsonrpc authenticated call",
    businessId: businessId ?? undefined,
    data: { method: typeof body.method === "string" ? body.method : "unknown", keyPrefix: validatedKey.slice(0, 4) + "…", tier: "owner" },
  });

  // After auth: enforce per-key rate limit. An attacker rotating IPs can bypass
  // checkRateLimit but cannot bypass this without generating new valid keys.
  if (!checkA2AKeyRateLimit(validatedKey)) {
    reportWarning("A2A per-key rate limit hit", { scope: "a2a.rate-limit-key" });
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32005, message: "Rate limit exceeded for this API key" } },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  try {
    // For anonymous callers (no businessId), ignore any client-supplied contextId and
    // generate a server-side random UUID instead. This prevents an external caller from
    // guessing a tenant's contextId and reading their in-memory session history.
    const rawContextId = extractContextIdFromParams(body.params);
    // SEC-T3-HIGH-3: validate contextId format before use in session key construction.
    // An unvalidated client-supplied contextId could be crafted as "victimBizId:anything"
    // to collide with another tenant's session key prefix. Reject malformed values so
    // the session key namespace stays clean — fall back to a server-generated UUID.
    const CONTEXT_ID_RE = /^[a-zA-Z0-9_-]{8,64}$/;
    const clientContextId = rawContextId && CONTEXT_ID_RE.test(rawContextId) ? rawContextId : null;
    const contextId = businessId !== null ? (clientContextId ?? randomUUID()) : randomUUID();
    // Session is keyed by businessId:contextId to prevent cross-tenant leakage.
    const history = getSession(contextId, businessId);
    const supervisorFn = (text: string) => supervisorAdapter(text, history);
    const response = await handleA2ARpc(body, supervisorFn);
    if ("result" in response && response.result) {
      const result = response.result as { parts?: Array<{ kind: string; text?: string }> };
      const agentText = result.parts?.find((p) => p.kind === "text")?.text ?? "";
      const userText = rawText ?? "";
      if (userText && agentText) saveSession(contextId, businessId, userText, agentText);
    }
    return json(response);
  } catch (error) {
    reportError(error, { scope: "a2a.jsonrpc", method: typeof body.method === "string" ? body.method : "unknown" });
    return json(rpcError(body?.id, JSON_RPC_ERRORS.INTERNAL_ERROR));
  }
}
