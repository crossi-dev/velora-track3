// A2A v0.3.0 JSON-RPC endpoint for the Velora Communications Agent.
// Auth: per-tenant derived X-API-Key (required) + X-Agent-Assertion JWT (Ed25519).
// Built on agent-rpc-factory.ts — same scaffold as Equipo, Ventas, Fiscal, Logística.
//
// Callers: all role-agents (supervisor, ventas, fiscal, logistica, payments) may
// invoke Comms to send outbound notifications.
//
// Scope: Web Push (VAPID/FCM), in-app ChatMessage writes. NOT WhatsApp.

// 40s: push send + DB write + ADK timeout (20s) + cold start headroom.
export const maxDuration = 40;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import { handleCommunicationsRpc } from "./_lib/handle-communications-rpc";

export const POST = createAgentRpcRoute({
  agentName: "communications",
  // "customer" added 2026-05-28: Customer Agent escalates to owner via WhatsApp
  // through Communications (B2C self-service path — escalate_to_owner).
  callerIdentity: ["supervisor", "ventas", "fiscal", "logistica", "payments", "customer"],
  // bucket + actorKey=businessId → effective key "communications-a2a:<businessId>"
  // per createAgentRpcRoute (agent-rpc-factory.ts:171). Each tenant has its own
  // 60/min counter; one noisy business cannot starve others.
  rateLimit: { bucket: "communications-a2a", max: 60, windowSec: 60 },
  handle: (body, ctx) => handleCommunicationsRpc(body, ctx),
});
