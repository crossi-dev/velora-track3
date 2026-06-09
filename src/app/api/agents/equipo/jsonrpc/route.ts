// A2A v0.3.0 JSON-RPC endpoint for the Velora Equipo Agent (RH/employees).
// Auth: per-tenant derived X-API-Key (required) + X-Agent-Assertion JWT (Ed25519).
// Rebuilt on agent-rpc-factory.ts (2026-05-25) — removes ~50 lines of duplicated
// auth/rate-limit/error scaffold shared with Payments, Fiscal, Ventas, Logística.

// 45s aligns with the supervisor's 38s caller timeout + headroom for cold
// start + DB connection acquire + serialization. ADK runner timeout inside
// the handler stays at 28s so the cascade fits inside this budget.
export const maxDuration = 45;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import { handleEquipoRpcAsync } from "./_lib/handle-equipo-rpc";

export const POST = createAgentRpcRoute({
  agentName: "equipo",
  callerIdentity: "supervisor",
  rateLimit: { bucket: "equipo-a2a", max: 20, windowSec: 60 },
  handle: (body, ctx) => handleEquipoRpcAsync(body, ctx),
});
