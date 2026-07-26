// A2A v0.3.0 JSON-RPC endpoint for the Velora Supervisor Agent.
// Auth: per-tenant derived X-API-Key (required) + X-Agent-Assertion JWT (Ed25519).
// Rebuilt on agent-rpc-factory.ts (2026-05-25) — removes ~60 lines of duplicated
// auth/rate-limit/error scaffold and fixes CRIT-4 (hardcoded iss="payments").
//
// callerIdentity lists ALL legitimate A2A peers that may call the Supervisor.
// The factory verifies assertion with short-circuit OR across the array —
// any registered peer with a valid signature is accepted.
//
// maxDuration 38s — stays under Cloud Run's 40s hard limit while giving
// the Supervisor's ADK loop + possible sub-agent round-trips room to breathe.

export const maxDuration = 38;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import { handleSupervisorRpc } from "./_lib/handle-supervisor-rpc";

export const POST = createAgentRpcRoute({
  agentName: "supervisor",
  callerIdentity: [
    "payments",
    "ventas",
    "fiscal",
    "logistica",
    "communications",
    "companion",
  ],
  rateLimit: { bucket: "supervisor-a2a", max: 20, windowSec: 60 },
  handle: (body, ctx) => handleSupervisorRpc(body, ctx),
});
