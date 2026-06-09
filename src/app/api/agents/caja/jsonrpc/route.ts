// A2A v0.3.0 JSON-RPC endpoint for the Velora Caja Agent.
// Auth: per-tenant derived X-API-Key (required) + X-Agent-Assertion JWT (Ed25519).
// Only accepts calls signed by the Supervisor (iss=supervisor).
// Cash-drawer agent: physical cash shifts, balance queries, ad-hoc movements.
//
// maxDuration: 35s — aligns with CAJA_ADK_TIMEOUT_MS=25s inner ADK budget
// + headroom for cold start, DB connection acquire, and serialization.
// The outer A2A client timeout CAJA_AGENT_TIMEOUT_MS=32s fits within this budget.
// Source: https://sre.google/sre-book/addressing-cascading-failures/

export const maxDuration = 35;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import { handleCajaRpc } from "./_lib/handle-caja-rpc";

export const POST = createAgentRpcRoute({
  agentName: "caja",
  // Caja Agent only accepts calls from the Supervisor.
  // No peer-agent skill-dispatch path (unlike Logística which accepts Payments).
  callerIdentity: ["supervisor"],
  rateLimit: { bucket: "caja-a2a", max: 60, windowSec: 60 },
  handle: (body, ctx) => handleCajaRpc(body, ctx),
});
