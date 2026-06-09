// A2A v0.3.0 JSON-RPC endpoint for the Velora Logística Agent.
// Auth: per-tenant derived X-API-Key (required) + X-Agent-Assertion JWT (Ed25519).
// Accepts calls signed by the Payments agent (iss=payments — shipment.quote
// while building a payment link) or by the Supervisor (iss=supervisor —
// shipment.create post-confirm + chat-driven calls).
// Supports skills: shipment.quote, shipment.create, shipment.track.
//
// Rebuilt on agent-rpc-factory.ts (2026-05-25) — removes ~55 lines of
// duplicated auth/rate-limit/error scaffold shared with Equipo, Fiscal, Ventas.

// 45s aligns with the supervisor's 38s caller timeout + headroom for cold
// start + DB connection acquire + serialization. ADK runner timeout inside
// the handler stays at 30s so the cascade fits inside this budget.
export const maxDuration = 45;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import { handleLogisticaRpc } from "./_lib/handle-logistica-rpc";

export const POST = createAgentRpcRoute({
  agentName: "logistica",
  // Logística serves three internal callers:
  //   - Payments agent (iss=payments) — shipment.quote while building a payment link
  //   - Supervisor (iss=supervisor)   — shipment.create post-confirm + chat-driven calls
  //   - Customer Agent (iss=customer) — quote_shipping for B2C self-service checkout
  callerIdentity: ["payments", "supervisor", "customer"],
  rateLimit: { bucket: "logistica-a2a", max: 60, windowSec: 60 },
  handle: (body, ctx) => handleLogisticaRpc(body, ctx),
});
