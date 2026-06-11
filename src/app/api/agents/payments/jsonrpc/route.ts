// A2A v0.3.0 JSON-RPC endpoint for the Velora Payments Agent.
// Auth: per-tenant derived X-API-Key (required) + X-Agent-Assertion JWT (Ed25519).
// Rebuilt on agent-rpc-factory.ts (2026-05-25) — removes 60-line auth/rate-limit
// scaffold shared with Equipo, Fiscal, Ventas, Logística. Route went 83 → 18 lines.
//
// BizSnapshot prefetch lives in handlePaymentsRpcAsync (handle-payments-rpc.ts),
// not in the factory, because it is Payments-domain knowledge (MP token hydration,
// pool-exhaustion fix). The factory's `handle` callback receives ctx.businessId and
// handlePaymentsRpcAsync owns the parallel prisma.business + mpConnection prefetch.

// 75s = PAYMENTS_ADK_TIMEOUT_MS (60s, raised 2026-05-27 commit 45efc23a because
// Gemini Pro thinking + MP API + shipping quote legitimately takes 25-30s) +
// 15s cleanup headroom. Senior audit (2026-05-27) caught the prior 45s < 60s
// hierarchy violation that hard-killed the route mid-tool-call. Cloud Run
// hard kill is 300s; we have plenty of margin. Per ADK 2026 best practice
// the route maxDuration should be ~80% of (or higher than) the inner ADK
// runner timeout to leave cleanup headroom.
export const maxDuration = 75;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import { handlePaymentsRpcAsync } from "./_lib/handle-payments-rpc";

export const POST = createAgentRpcRoute({
  agentName: "payments",
  // Two internal callers:
  //   - Supervisor (iss=supervisor) — owner-initiated payment links via chat
  //   - Customer Agent (iss=customer) — B2C self-service checkout (inbound wpp
  //     worker → Customer Agent → create_payment_link)
  callerIdentity: ["supervisor", "customer"],
  // 200/min: internal Cloud Run self-calls from the Customer Agent share the same
  // in-memory window as concurrent traffic. The old 20/min was too tight for
  // sustained smoke/integration test runs on a long-lived instance. 200/min
  // = ~3/s burst ceiling. Auth (HMAC + Ed25519 JWT) is the real security gate.
  rateLimit: { bucket: "payments-a2a", max: 200, windowSec: 60 },
  handle: (body, ctx) => handlePaymentsRpcAsync(body, ctx),
});
