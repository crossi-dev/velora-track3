import "server-only";
// Client for invoking Velora's Vertex Agent Engine deployment from the
// Cloud Run TS app. Runtime feature flag `USE_AGENT_ENGINE=true` activates
// the path; default routes through the local TS ADK agents (lower latency,
// no extra network hop).
//
// Why this exists: the contest mandate says "Focus on the deployment of
// your multi-agent system on Agent Engine." We deploy the agents to Agent
// Engine via agent-engine/deploy.py, and this client lets the Cloud Run
// app forward queries there to demonstrate the full end-to-end path.
//
// Architecture:
//   Cloud Run (TS app, primary) ─── interactive chat ───▶ local ADK agents
//                                ─── (flag enabled) ────▶ Agent Engine endpoint
//   Agent Engine (Python ADK)  ─── A2A consumer for async events
//
// Auth: Application Default Credentials inherit from Cloud Run service
// account. The runtime SA needs `roles/aiplatform.user` (already granted
// by scripts/deploy-gcp.sh).

import { GoogleAuth } from "google-auth-library";
import { cloudLog } from "@/lib/cloud-logger";

const LOCATION = process.env.VERTEX_LOCATION || "us-central1";

let cachedAuth: GoogleAuth | null = null;
function getAuth() {
  if (!cachedAuth) {
    cachedAuth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }
  return cachedAuth;
}

export function isAgentEngineEnabled(): boolean {
  return (
    process.env.USE_AGENT_ENGINE === "true"
    && Boolean(process.env.AGENT_ENGINE_RESOURCE_NAME)
  );
}

export function getAgentEngineResourceName(): string | null {
  return process.env.AGENT_ENGINE_RESOURCE_NAME ?? null;
}

interface AgentEngineQueryArgs {
  /** Free-form user input (cashier message, supervisor event payload, etc). */
  input: string;
  /**
   * Sub-agent selector: "employee" routes to the Employee Agent inside the
   * AdkApp; otherwise the Supervisor (root agent) handles the request.
   */
  subAgent?: "employee" | "supervisor";
  /** Stable session/business identifier — Agent Engine uses it for memory. */
  sessionId?: string;
  timeoutMs?: number;
}

interface AgentEngineQueryResult {
  text: string;
  raw: unknown;
}

/**
 * Invoke the deployed Agent Engine reasoning engine via the public REST
 * endpoint `:query`. Returns the agent's textual response, or null if the
 * call fails / the flag is disabled / no deployment is configured.
 *
 * Caller decides what to do with the response (parse JSON, display, etc).
 * This is intentionally a thin client — the agent handles the reasoning.
 */
export async function queryAgentEngine(args: AgentEngineQueryArgs): Promise<AgentEngineQueryResult | null> {
  if (!isAgentEngineEnabled()) return null;
  const resource = getAgentEngineResourceName();
  if (!resource) return null;

  const { input, subAgent, sessionId, timeoutMs = 8000 } = args;
  if (!input || typeof input !== "string") return null;

  const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/${resource}:query`;
  const body = {
    input: {
      query: input,
      ...(subAgent ? { sub_agent: subAgent } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const auth = getAuth();
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    const token = typeof tokenResp === "string" ? tokenResp : tokenResp?.token;
    if (!token) return null;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const data = await res.json() as { output?: { text?: string } | string };
    const text = typeof data.output === "string"
      ? data.output
      : data.output?.text ?? "";
    if (!text) return null;
    return { text, raw: data };
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "AGENT_ENGINE_QUERY_ERROR",
      a2a_transfer: false,
      message: "Agent Engine query failed — returning null",
      data: { error: err instanceof Error ? err.message : String(err), resource },
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
