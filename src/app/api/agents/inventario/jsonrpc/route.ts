// A2A v0.3.0 JSON-RPC endpoint for the Velora Inventario Agent (stock + catalog).
// Auth: per-tenant derived X-API-Key (required) + X-Agent-Assertion JWT (Ed25519).
// Built on agent-rpc-factory.ts (same as Equipo, Ventas, Logística) — removes
// ~50 lines of duplicated auth/rate-limit/error scaffold.
//
// 45s aligns with the supervisor's caller timeout + headroom for cold start +
// DB connection acquire (product catalog prefetch) + serialization.
// ADK runner timeout inside the handler stays at 30s so the cascade fits inside
// this budget. Outer client (INVENTARIO_AGENT_TIMEOUT_MS) = 42s.
export const maxDuration = 45;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import { handleInventarioRpcAsync } from "./_lib/handle-inventario-rpc";

export const POST = createAgentRpcRoute({
  agentName: "inventario",
  callerIdentity: "supervisor",
  rateLimit: { bucket: "inventario-a2a", max: 20, windowSec: 60 },
  handle: (body, ctx) => handleInventarioRpcAsync(body, ctx),
});
