// A2A v0.3.0 JSON-RPC endpoint for the Velora Customer Agent.
// Auth: per-tenant derived X-API-Key + X-Agent-Assertion JWT (Ed25519).
// Built on agent-rpc-factory.ts — shares auth/rate-limit scaffold with other agents.
//
// callerIdentity: ["supervisor"] — only the Supervisor delegates to the Customer Agent.
// Customers do NOT authenticate as A2A peers; they enter via webhook in future.
//
// 100s route duration: Customer Agent ADK budget is 90s (CUSTOMER_AGENT_ADK_TIMEOUT_MS)
// + 10s cleanup headroom. Raised from 75s to match the raised ADK budget.
// Without this the platform kills the route while the ADK runner still has budget left
// → hard platform kill mid-tool-call (M3 fix 2026-05-29).
// Hierarchy: route maxDuration (100) ≥ ADK inner budget (90). ✓
// Cloud Run hard limit is 300s; 100s leaves ample margin.
//
// A2A Protocol v1.0: https://a2a-protocol.org/latest/specification/

export const maxDuration = 100;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import { handleCustomerRpcAsync } from "./_lib/handle-customer-rpc";

export const POST = createAgentRpcRoute({
  agentName: "customer",
  callerIdentity: ["supervisor"],
  rateLimit: { bucket: "customer-a2a", max: 30, windowSec: 60 },
  handle: (body, ctx) => handleCustomerRpcAsync(body, ctx),
});
