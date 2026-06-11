import "server-only";
// /api/public/judge-query — unauthenticated endpoint for Track 3 judges.
//
// Sends a FIXED, hardcoded query to Velora's Vertex AI Agent Engine deployment
// (live resource id at somosvelora.com/track3).
//
// Security model:
//   - No user input accepted. `q` param is ignored to prevent abuse.
//   - businessId is hardcoded (demo tenant only).
//   - /api/public is already in API_ALLOWLIST (src/middleware.ts).
//   - Dual rate limiting: checkRateLimitPublic (30/60s per IP in-memory) +
//     a simple per-IP 1/30s guard for this specific route.
//
// Auth: GoogleAuth ADC — Cloud Run SA inherits roles/aiplatform.user.
// Timeout: 15s with {status:"warming_up"} graceful fallback.

import { NextRequest, NextResponse } from "next/server";
import { GoogleAuth } from "google-auth-library";
import { checkRateLimitPublic } from "@/app/api/_lib/route-helpers";
import { getClientIp } from "@/lib/client-ip";
import { cloudLog } from "@/lib/cloud-logger";

// Hardcoded — cannot be overridden by caller.
const FIXED_QUERY = "Show me products for carrying things on your back";
const DEMO_BUSINESS_ID = "cmpow3rq70009s601j07xgmf0";
const DEMO_USER_ID = `judge-demo-${DEMO_BUSINESS_ID}`;
// Live resource id: see somosvelora.com/track3 or gcloud ai reasoning-engines list
const AGENT_ENGINE_RESOURCE =
  process.env.AGENT_ENGINE_RESOURCE_NAME ??
  "projects/my-gcp-project/locations/us-central1/reasoningEngines/<id>";
const LOCATION = process.env.VERTEX_LOCATION ?? "us-central1";
const TIMEOUT_MS = 15_000;

// Per-IP 1/30s guard (in-memory, single-instance; fits scale-to-zero demo usage).
const perIpLastCall = new Map<string, number>();

let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!_auth) {
    _auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }
  return _auth;
}

// ── Stream parser ─────────────────────────────────────────────────────────────

interface SlimResult {
  model?: string;
  toolCall?: string;
  toolResponse?: string;
  answer?: string;
  resourcePath: string;
}

// ADK Agent Engine :streamQuery response shape (NDJSON, one JSON object per line):
//   { model_version?, content: { parts: [{text?} | {function_call?} | {function_response?}], role }, author, ... }

type AdkPart =
  | { text: string }
  | { function_call: { name: string; args?: unknown }; thought_signature?: string }
  | { function_response: { name: string; response?: unknown } };

interface AdkEvent {
  model_version?: string;
  content?: { parts?: AdkPart[]; role?: string };
  author?: string;
}

/** Parse NDJSON stream from Agent Engine :streamQuery into slim JSON. */
async function parseStream(body: ReadableStream<Uint8Array>): Promise<SlimResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const result: SlimResult = { resourcePath: AGENT_ENGINE_RESOURCE };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "[" || trimmed === "]") continue;
        const jsonStr = trimmed.replace(/^,/, "");
        try {
          const obj = JSON.parse(jsonStr) as AdkEvent;
          if (!result.model && obj.model_version) {
            result.model = obj.model_version;
          }
          if (obj.content?.parts) {
            for (const part of obj.content.parts) {
              if ("text" in part && part.text) {
                if (obj.content.role === "model" || !obj.content.role) {
                  result.answer = (result.answer ?? "") + part.text;
                }
              } else if ("function_call" in part && part.function_call?.name) {
                result.toolCall = `${part.function_call.name}(${JSON.stringify(part.function_call.args ?? {}).slice(0, 200)})`;
              } else if ("function_response" in part && part.function_response) {
                result.toolResponse = JSON.stringify(part.function_response.response).slice(0, 400);
              }
            }
          }
        } catch {
          // Non-JSON line — skip silently
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return result;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Layer 1: general public rate limit (30/60s per IP)
  const rateLimited = checkRateLimitPublic(req);
  if (rateLimited) return rateLimited;

  // Layer 2: per-route 1/30s guard
  const ip = getClientIp(req.headers) ?? "unknown";
  const now = Date.now();
  const lastCall = perIpLastCall.get(ip) ?? 0;
  if (now - lastCall < 30_000) {
    return NextResponse.json({ status: "rate_limited" }, { status: 429 });
  }
  perIpLastCall.set(ip, now);

  if (perIpLastCall.size > 1000) {
    const cutoff = now - 120_000;
    for (const [k, ts] of perIpLastCall) {
      if (ts < cutoff) perIpLastCall.delete(k);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const auth = getAuth();
    const client = await auth.getClient();
    const tokenResp = await client.getAccessToken();
    const token = typeof tokenResp === "string" ? tokenResp : tokenResp?.token;

    if (!token) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "JUDGE_QUERY_NO_TOKEN",
        a2a_transfer: false,
        message: "judge-query: could not obtain ADC token",
      });
      return NextResponse.json({ status: "warming_up" }, { status: 200 });
    }

    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/${AGENT_ENGINE_RESOURCE}:streamQuery`;
    const body = {
      class_method: "async_stream_query",
      input: {
        message: FIXED_QUERY,
        user_id: DEMO_USER_ID,
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "JUDGE_QUERY_AE_ERROR",
        a2a_transfer: false,
        message: `Agent Engine returned ${res.status}`,
        data: { status: res.status, body: errText.slice(0, 300) },
      });
      return NextResponse.json({ status: "warming_up" }, { status: 200 });
    }

    if (!res.body) {
      return NextResponse.json({ status: "warming_up" }, { status: 200 });
    }

    const result = await parseStream(res.body);
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: isTimeout ? "JUDGE_QUERY_TIMEOUT" : "JUDGE_QUERY_ERROR",
      a2a_transfer: false,
      message: isTimeout ? "judge-query timed out" : "judge-query error",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json({ status: "warming_up" }, { status: 200 });
  } finally {
    clearTimeout(timer);
  }
}
