// A2A v0.3.0 JSON-RPC endpoint for the Velora Companion Agent.
// Auth: per-tenant derived X-API-Key (required) + X-Agent-Assertion JWT (Ed25519).
// Rebuilt on agent-rpc-factory.ts — removes duplicated auth/rate-limit scaffold.
// Accepts calls signed by the Supervisor only (iss=supervisor).
// Skill: assist.employee.turn — employee message → Companion response + RBAC gate.

export const maxDuration = 38;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import { handleCompanionRpcAsync } from "./_lib/handle-companion-rpc";

export const POST = createAgentRpcRoute({
  agentName: "companion",
  callerIdentity: "supervisor",
  rateLimit: { bucket: "companion-a2a", max: 20, windowSec: 60 },
  handle: (body, ctx) => handleCompanionRpcAsync(body, { businessId: ctx.businessId }),
});
