import "server-only";
// Vertex AI Agent Engine — Memory Bank client.
// Persists per-owner learned preferences (UX style, correction patterns,
// vocabulary) so the Supervisor can inject them into subsequent turns.
//
// Feature flag: USE_MEMORY_BANK=true (default: false).
// Fail-soft: every public function catches all errors and returns [] / void
// so a Memory Bank outage never breaks the chat pipeline.
//
// Auth: Application Default Credentials from the Cloud Run service account.
// The SA already holds roles/aiplatform.user — no extra grants needed.
//
// Agent Engine resource:
//   projects/000000000000/locations/us-central1/reasoningEngines/REASONING_ENGINE_ID
// Memory Bank REST base:
//   https://us-central1-aiplatform.googleapis.com/v1/{parent}/memories

import { GoogleAuth } from "google-auth-library";
import { cloudLog } from "@/lib/cloud-logger";

// ─── Config ────────────────────────────────────────────────────────────────

const AGENT_ENGINE_RESOURCE =
  process.env.AGENT_ENGINE_RESOURCE_NAME ??
  "projects/000000000000/locations/us-central1/reasoningEngines/REASONING_ENGINE_ID";

const LOCATION = "us-central1";
const API_BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1`;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OwnerMemory {
  /** Full resource name, e.g. ".../memories/123456789" */
  name: string;
  /** Raw text of the observation, e.g. "Owner prefers short answers" */
  content: string;
  /** ISO-8601 timestamp from the API */
  createTime: string;
  /** Canonical scope key — always `owner_id:{businessId}` */
  scope: string;
}

// ─── Feature flag ──────────────────────────────────────────────────────────

export function isMemoryBankEnabled(): boolean {
  return process.env.USE_MEMORY_BANK === "true";
}

// ─── Auth ───────────────────────────────────────────────────────────────────

let _auth: GoogleAuth | null = null;
function getAuth(): GoogleAuth {
  if (!_auth) {
    _auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }
  return _auth;
}

async function getToken(): Promise<string | null> {
  try {
    const auth = getAuth();
    const client = await auth.getClient();
    const resp = await client.getAccessToken();
    return typeof resp === "string" ? resp : (resp?.token ?? null);
  } catch {
    return null;
  }
}

// ─── Scope helpers ──────────────────────────────────────────────────────────

/**
 * Canonical scope key string — used for post-fetch comparison and display.
 * Format: "owner_id:{businessId}" — matches the key name in the scope map.
 */
function ownerScopeKey(businessId: string): string {
  return `owner_id:${businessId}`;
}

/**
 * Scope object for Vertex AI Memory Bank API calls.
 * Vertex AI Agent Engine expects scope as a map<string, string>, NOT a flat
 * colon-delimited string. Sending "owner:id" causes a 400:
 * "Invalid value at 'scope' — owner:…". Fix: BUG #41.
 */
function ownerScopeObj(businessId: string): Record<string, string> {
  return { owner_id: businessId };
}

// ─── API helpers ─────────────────────────────────────────────────────────────

const MEMORY_BANK_TIMEOUT_MS = 5_000;

export async function memoriesRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<unknown | null> {
  const token = await getToken();
  if (!token) return null;

  const url = `${API_BASE}/${AGENT_ENGINE_RESOURCE}/${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEMORY_BANK_TIMEOUT_MS);
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    signal: controller.signal,
  };
  if (body !== undefined) opts.body = JSON.stringify(body);

  try {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Memory Bank ${method} ${path} → ${res.status}: ${errText.slice(0, 200)}`);
    }
    if (method === "DELETE") return null;
    return res.json() as unknown;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Persist a learned preference for a specific owner (businessId).
 * Fire-and-forget safe — callers may void this.
 */
export async function saveOwnerMemory(
  businessId: string,
  content: string,
): Promise<void> {
  if (!isMemoryBankEnabled()) return;
  if (!content.trim()) return;

  try {
    await memoriesRequest("POST", "memories", {
      scope: ownerScopeObj(businessId),
      content,
    });
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MEMORY_BANK_SAVE_FAILED",
      a2a_transfer: false,
      message: "Memory Bank save failed — skipping",
      businessId,
      data: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/**
 * Retrieve memories for a specific owner (businessId).
 * Returns [] on error so the caller can proceed without memories.
 * `_query` kept for API compat — memories:retrieve no longer accepts `query`/`top_k`.
 */
export async function retrieveOwnerMemories(
  businessId: string,
  _query: string,
): Promise<OwnerMemory[]> {
  if (!isMemoryBankEnabled()) return [];

  // PL-2: declare the expected scope key before the fetch so we can validate
  // post-fetch that Vertex only returned memories belonging to this business.
  const expectedScopeKey = ownerScopeKey(businessId);

  try {
    const data = await memoriesRequest("POST", "memories:retrieve", {
      scope: ownerScopeObj(businessId),
    }) as { memories?: Array<{ name?: string; content?: string; createTime?: string; scope?: string }> } | null;

    if (!data?.memories) return [];

    const mapped = data.memories
      .filter((m) => typeof m.content === "string" && m.content.length > 0)
      .map((m) => ({
        name: m.name ?? "",
        content: m.content ?? "",
        createTime: m.createTime ?? new Date().toISOString(),
        scope: m.scope ?? expectedScopeKey,
      }));

    // PL-2: defense in depth — filter out any memory whose scope doesn't exactly
    // match what we requested. A prefix-match bug or API regression would otherwise
    // silently leak another business's memories into our prompts.
    const safe = mapped.filter((m) => m.scope === expectedScopeKey);
    const droppedCount = mapped.length - safe.length;
    if (droppedCount > 0) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "MEMORY_BANK_SCOPE_LEAK_FILTERED",
        a2a_transfer: false,
        message: "Vertex returned memories with unexpected scope — dropped before prompt injection",
        businessId,
        data: { expectedScopeKey, droppedCount },
      });
    }

    return safe;
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MEMORY_BANK_RETRIEVE_FAILED",
      a2a_transfer: false,
      message: "Memory Bank retrieve failed — returning empty",
      businessId,
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }
}

/**
 * Fetch ALL memories for an owner (for UI display, max 100).
 * Returns [] on error.
 */
export async function listOwnerMemories(businessId: string): Promise<OwnerMemory[]> {
  if (!isMemoryBankEnabled()) return [];

  try {
    const data = await memoriesRequest(
      "GET",
      `memories?filter=scope.owner_id="${businessId}"&page_size=100`,
    ) as { memories?: Array<{ name?: string; content?: string; createTime?: string; scope?: string }> } | null;

    if (!data?.memories) return [];

    return data.memories
      .filter((m) => typeof m.content === "string" && m.content.length > 0)
      .map((m) => ({
        name: m.name ?? "",
        content: m.content ?? "",
        createTime: m.createTime ?? new Date().toISOString(),
        scope: m.scope ?? ownerScopeKey(businessId),
      }))
      .sort((a, b) => new Date(b.createTime).getTime() - new Date(a.createTime).getTime());
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MEMORY_BANK_LIST_FAILED",
      a2a_transfer: false,
      message: "Memory Bank list failed — returning empty",
      businessId,
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return [];
  }
}

/**
 * Delete a single memory by its full resource name.
 * Fail-soft: logs warning if deletion fails, never throws.
 */
export async function deleteOwnerMemory(memoryName: string): Promise<void> {
  if (!isMemoryBankEnabled()) return;
  if (!memoryName.trim()) return;

  // Extract relative path: everything after ".../reasoningEngines/{id}/"
  const rawId = memoryName.includes("/memories/")
    ? memoryName.split("/memories/").at(-1)
    : memoryName;

  // Guard against path-traversal: the memory id must be a pure alphanumeric
  // token (digits, letters, underscores, hyphens). Slashes, dots, or any other
  // characters would let a crafted memoryName reach arbitrary Vertex AI paths.
  if (!rawId || !/^[A-Za-z0-9_-]+$/.test(rawId)) {
    throw new Error(`deleteOwnerMemory: unsafe or empty memory id "${rawId ?? ""}"`);
  }

  const rel = `memories/${rawId}`;

  try {
    await memoriesRequest("DELETE", rel);
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "MEMORY_BANK_DELETE_FAILED",
      a2a_transfer: false,
      message: "Memory Bank delete failed",
      businessId: "",
      data: { memoryName, error: err instanceof Error ? err.message : String(err) },
    });
  }
}
