/**
 * Canonical timeout constants for A2A agent-to-agent RPC calls and
 * embedding/search operations. Named constants eliminate magic numbers
 * and make it easy to review and tune timeouts in one place.
 *
 * ── Timeout Hierarchy (inner → outer, Google SRE Deadline Propagation) ────────
 * Source: https://sre.google/sre-book/addressing-cascading-failures/
 * Rule: every OUTER A2A client timeout MUST exceed the target agent's INNER
 * ADK timeout + ~12s network/serialization margin. This ensures the A2A caller
 * receives a structured error from the agent rather than an opaque network
 * timeout, enabling proper error propagation and circuit-breaking.
 *
 * Agent           | Inner ADK (env var)            | Outer client (env var)          | Margin
 * ----------------+--------------------------------+---------------------------------+-------
 * Ventas          | VENTAS_ADK_TIMEOUT_MS  = 30s   | VENTAS_AGENT_TIMEOUT_MS   = 42s | +12s
 * Logística       | LOGISTICA_ADK_TIMEOUT_MS = 35s | LOGISTICA_AGENT_TIMEOUT_MS= 47s | +12s
 * Fiscal/Contador | FISCAL_ADK_TIMEOUT_MS  = 40s   | CONTADOR_AGENT_TIMEOUT_MS = 52s | +12s
 * Communications  | COMMUNICATIONS_ADK_TIMEOUT_MS=20s|COMMUNICATIONS_AGENT_TIMEOUT_MS=32s|+12s
 * Payments        | PAYMENTS_ADK_TIMEOUT_MS= 60s   | PAYMENTS_AGENT_TIMEOUT_MS = 72s | +12s
 * Customer Agent  | CUSTOMER_AGENT_ADK=90s         | CUSTOMER_AGENT_DISPATCH=100s    | +10s
 * Caja            | CAJA_ADK_TIMEOUT_MS    = 25s   | CAJA_AGENT_TIMEOUT_MS     = 32s | +7s
 *
 * Supervisor/outer-gate constraints (all sub-agent outer clients must be ≤):
 *   SUPERVISOR_ADK_TIMEOUT_MS  = 35s (code) / 65s (Cloud Run) — sub-agent outers < 65s ✓
 *   LLM_TIMEOUT_MS             = 40s (code) / 80s (Cloud Run) — fast-path outers < 80s ✓
 *   CUSTOMER_AGENT_ADK         = 90s — customer-path outers < 90s ✓
 *   Route maxDuration          = 300s — all JS gates fire before this ✓
 *
 * Triggers (fire-and-forget A2A calls — must exceed their sub-agent's inner ADK):
 *   FISCAL_RECEIPT_TRIGGER_TIMEOUT_MS  = 52s (> fiscal inner 40s)
 *   SHIPMENT_CREATE_TRIGGER_TIMEOUT_MS = 47s (> logística inner 35s)
 *   SHIPPING_QUOTE_TIMEOUT_MS          = 20s (standalone Andreani HTTP — not an ADK call)
 *
 * p99 optimization pass: these values are GENEROUS by design (kill inversions first,
 * tune down to measured p99 later). Do NOT tighten without real latency data.
 */

/**
 * Outer JS-layer deadline for /api/business-assistant.
 * Pulled from LLM_TIMEOUT_MS env var (same source as route.ts) so every
 * consumer agrees on a single absolute ceiling without re-reading env vars.
 * Cloud Run override: LLM_TIMEOUT_MS=80000.
 */
export const OUTER_GATE_MS = Number(process.env.LLM_TIMEOUT_MS ?? "40000");

/**
 * Returns milliseconds remaining in the outer request budget.
 *
 * Pattern: Google SRE Book — Deadline Propagation
 * https://sre.google/sre-book/addressing-cascading-failures/
 *
 * @param startedAt   - Date.now() captured at request entry (before rate-limit, DB, etc.)
 * @param reservedMs  - Buffer for local work after the A2A call returns (default 5 s).
 * @returns Remaining ms, floored at 0. Use as timeoutMs in sendMessage calls.
 */
export function remainingBudget(startedAt: number, reservedMs = 5_000): number {
  const elapsed = Date.now() - startedAt;
  return Math.max(0, OUTER_GATE_MS - elapsed - reservedMs);
}

// ── ADK tool call timeouts (outer A2A clients) ─────────────────────────────

/**
 * Payments agent: link creation + MP preference.
 * Inner ADK = 60s (PAYMENTS_ADK_TIMEOUT_MS in handle-payments-rpc.ts).
 * Outer = 72s = 60s inner + 12s margin. < LLM_TIMEOUT 80s ✓ (owner fast-path).
 * < CUSTOMER_AGENT_ADK 90s ✓ (customer path).
 * Env-overridable for live tuning without redeploy.
 */
export const PAYMENTS_AGENT_TIMEOUT_MS = Number(
  process.env.PAYMENTS_AGENT_TIMEOUT_MS ?? "72000",
);

/**
 * Ventas agent: sale creation, catalog, stock ops.
 * Inner ADK = 30s (VENTAS_ADK_TIMEOUT_MS in handle-ventas-rpc.ts).
 * Outer = 42s = 30s inner + 12s margin. < SUPERVISOR_ADK 65s ✓.
 * Env-overridable for live tuning without redeploy.
 */
export const VENTAS_AGENT_TIMEOUT_MS = Number(
  process.env.VENTAS_AGENT_TIMEOUT_MS ?? "42000",
);

/**
 * Contador (Fiscal) agent: fiscal receipt, balance queries.
 * Inner ADK = 40s (FISCAL_ADK_TIMEOUT_MS in handle-fiscal-rpc.ts).
 * Outer = 52s = 40s inner + 12s margin. < SUPERVISOR_ADK 65s ✓.
 * Env-overridable for live tuning without redeploy.
 */
export const CONTADOR_AGENT_TIMEOUT_MS = Number(
  process.env.CONTADOR_AGENT_TIMEOUT_MS ?? "52000",
);

/**
 * Logística agent: Andreani/OCA/Correo booking and tracking.
 * Inner ADK = 35s (LOGISTICA_ADK_TIMEOUT_MS in handle-logistica-rpc.ts).
 * Outer = 47s = 35s inner + 12s margin. < SUPERVISOR_ADK 65s ✓.
 * Env-overridable for live tuning without redeploy.
 */
export const LOGISTICA_AGENT_TIMEOUT_MS = Number(
  process.env.LOGISTICA_AGENT_TIMEOUT_MS ?? "47000",
);

/**
 * Communications agent: WhatsApp send, push, broadcast.
 * Inner ADK = 20s (COMMUNICATIONS_ADK_TIMEOUT_MS in handle-communications-rpc.ts).
 * Outer = 32s = 20s inner + 12s margin. < SUPERVISOR_ADK 65s ✓.
 * Env-overridable for live tuning without redeploy.
 */
export const COMMUNICATIONS_AGENT_TIMEOUT_MS = Number(
  process.env.COMMUNICATIONS_AGENT_TIMEOUT_MS ?? "32000",
);

/**
 * Customer Agent dispatch — outer A2A client timeout used by the WhatsApp
 * inbound worker when it self-calls /api/agents/customer/jsonrpc.
 *
 * Deadline Propagation (Google SRE Book — Addressing Cascading Failures):
 *   https://sre.google/sre-book/addressing-cascading-failures/
 *   Inner CUSTOMER_AGENT_ADK_TIMEOUT_MS = 90_000 (customer-agent.ts —
 *   checkout chain: shipping 12s + payments 60s + reasoning 15s = ~87s).
 *   Outer client MUST exceed inner budget + network/serialization margin.
 *   Default 100_000 = 90_000 inner + 10_000 margin.
 *   Cloud Run override: CUSTOMER_AGENT_DISPATCH_TIMEOUT_MS=100000.
 *
 * Bug it fixed (2026-05-28): wpp inbound dispatch was using COMMUNICATIONS_AGENT_TIMEOUT_MS
 * (15_000) which is for Communications agent calls, not Customer Agent. The webhook
 * hung up at 15s while the Customer Agent was mid-chain (catalog → address →
 * shipping → payment), producing WEBHOOK_DISPATCH_ERROR while the agent kept running.
 */
export const CUSTOMER_AGENT_DISPATCH_TIMEOUT_MS = Number(
  process.env.CUSTOMER_AGENT_DISPATCH_TIMEOUT_MS ?? "100000",
);

/**
 * Inventario agent: stock queries, catalog ops, adjustments.
 * Inner ADK = 30s (INVENTARIO_ADK_TIMEOUT_MS in handle-inventario-rpc.ts).
 * Outer = 42s = 30s inner + 12s margin. < SUPERVISOR_ADK 65s ✓.
 * Env-overridable for live tuning without redeploy.
 */
export const INVENTARIO_AGENT_TIMEOUT_MS = Number(
  process.env.INVENTARIO_AGENT_TIMEOUT_MS ?? "42000",
);

// ── Direct A2A / payment-intent trigger timeouts ──────────────────────────

/**
 * Fiscal receipt trigger (triggerFiscalReceipt).
 * Must exceed fiscal inner ADK (40s) + margin. = 52s = 40s + 12s.
 * Env-overridable for live tuning without redeploy.
 */
export const FISCAL_RECEIPT_TRIGGER_TIMEOUT_MS = Number(
  process.env.FISCAL_RECEIPT_TRIGGER_TIMEOUT_MS ?? "52000",
);

/**
 * Shipment create trigger (triggerShipmentCreate).
 * Must exceed logística inner ADK (35s) + margin. = 47s = 35s + 12s.
 * Env-overridable for live tuning without redeploy.
 */
export const SHIPMENT_CREATE_TRIGGER_TIMEOUT_MS = Number(
  process.env.SHIPMENT_CREATE_TRIGGER_TIMEOUT_MS ?? "47000",
);

/**
 * Payment link fast-path A2A call (execute-payment-link-fast-path.ts).
 *
 * Deadline propagation (Google SRE Book — Addressing Cascading Failures):
 *   https://sre.google/sre-book/addressing-cascading-failures/
 *   Inner ADK runner budget: PAYMENTS_ADK_TIMEOUT_MS = 60_000 ms.
 *   Outer MUST exceed inner + network margin.
 *   Default 72_000 = 60_000 inner + 12_000 margin.
 *   The outer JS gate LLM_TIMEOUT_MS=80_000 still caps the whole turn (72s < 80s ✓).
 *   Old Cloud Run value was 55_000 — less than the inner 60s ADK budget (inverted
 *   hierarchy); caller timed out while agent kept running, orphaning PaymentIntents.
 *   Fixed 2026-05-29.
 * Env-overridable for live tuning without redeploy.
 */
export const PAYMENT_LINK_FAST_PATH_TIMEOUT_MS = Number(
  process.env.PAYMENT_LINK_FAST_PATH_TIMEOUT_MS ?? "72000",
);

/** Shipping quote (shipping-quote.ts default). Standalone Andreani HTTP — not an ADK call. */
export const SHIPPING_QUOTE_TIMEOUT_MS = Number(
  process.env.SHIPPING_QUOTE_TIMEOUT_MS ?? "20000",
);

// ── Embedding / search timeouts ────────────────────────────────────────────

/** embedText for few-shot learner and feedback relabeler. */
export const EMBED_TEXT_TIMEOUT_MS = 3_000;

/** embedQuery for few-shot retrieval (read path — tighter budget). */
export const EMBED_QUERY_TIMEOUT_MS = 1_500;

/** Vertex AI Search query timeout. */
export const VERTEX_SEARCH_TIMEOUT_MS = 1_500;

/**
 * A2A transport loopback default timeout (LoopbackTransport in a2a-transport.ts).
 * Exported for documentation; a2a-transport.ts imports this to eliminate the
 * inline magic literal 12_000 on line ~77.
 */
export const A2A_TRANSPORT_DEFAULT_TIMEOUT_MS = 12_000;

/** Agent Engine sub-agent call (agent-engine-client.ts default). Exported for documentation. */
export const AGENT_ENGINE_SUB_AGENT_TIMEOUT_MS = 8_000;

/**
 * Caja agent: physical cash shift open/close, balance query, ad-hoc movements.
 * Inner ADK = 25s (CAJA_ADK_TIMEOUT_MS in handle-caja-rpc.ts — DB-only ops, fast).
 * Outer = 32s = 25s inner + 7s margin. < route maxDuration 35s ✓.
 * (jd/caja-agent C-1: was 37s, which EXCEEDED maxDuration 35s — inverted hierarchy;
 *  Cloud Run killed the handler before the client timed out. Lowered to 32s.)
 * Env-overridable for live tuning without redeploy.
 * Source: https://sre.google/sre-book/addressing-cascading-failures/
 */
export const CAJA_AGENT_TIMEOUT_MS = Number(
  process.env.CAJA_AGENT_TIMEOUT_MS ?? "32000",
);
