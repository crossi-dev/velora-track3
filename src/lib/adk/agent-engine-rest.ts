import "server-only";
// REST transport layer for Vertex AI Agent Engine Sessions API.
// Extracted from agent-engine-session-service.ts to stay within the 250-line
// new-file limit (project conventions).

import { GoogleAuth } from "google-auth-library";
import { cloudLog } from "@/lib/cloud-logger";

// ── Config ────────────────────────────────────────────────────────────────────

const LOCATION = process.env.VERTEX_LOCATION || "us-central1";
const BASE_URL = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1`;
// Tight timeout so a slow Agent Engine doesn't stall the interactive pipeline.
export const AE_CALL_TIMEOUT_MS = 5_000;

// ── Auth ──────────────────────────────────────────────────────────────────────

let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!_auth) {
    _auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }
  return _auth;
}

async function getBearerToken(): Promise<string | null> {
  try {
    const auth = getAuth();
    const client = await auth.getClient();
    const resp = await client.getAccessToken();
    const token = typeof resp === "string" ? resp : resp?.token;
    return token ?? null;
  } catch { return null; }
}

// ── Sessions base URL ─────────────────────────────────────────────────────────

export function sessionsBase(resourceName: string): string {
  return `${BASE_URL}/${resourceName}/sessions`;
}

// ── REST helpers ──────────────────────────────────────────────────────────────

export interface AeApiOptions {
  method: string;
  path: string;
  body?: unknown;
}

/** Fetch wrapper: auth header, timeout, JSON in/out, returns null on any error. */
export async function aeApiFetch<T>(opts: AeApiOptions): Promise<T | null> {
  const token = await getBearerToken();
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AE_CALL_TIMEOUT_MS);

  try {
    const res = await fetch(opts.path, {
      method: opts.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      signal: controller.signal,
    });

    if (!res.ok) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "AE_SESSION_API_ERROR",
        a2a_transfer: false,
        message: `Agent Engine session API returned ${res.status}`,
        data: { method: opts.method, status: res.status },
      });
      return null;
    }
    if (res.status === 204) return null;
    return (await res.json()) as T;
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "AE_SESSION_FETCH_ERROR",
      a2a_transfer: false,
      message: "Agent Engine session fetch failed",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  } finally { clearTimeout(timer); }
}

// ── Agent Engine response shapes ──────────────────────────────────────────────

export interface AeSession {
  name?: string;
  userId?: string;
  createTime?: string;
  updateTime?: string;
  sessionState?: Record<string, unknown>;
  events?: AeEvent[];
}

export interface AeEvent {
  id?: string;
  author?: string;
  timestamp?: string;
  content?: {
    role?: string;
    parts?: Array<{ text?: string }>;
  };
}

export interface AeListSessionsResponse {
  sessions?: AeSession[];
}
