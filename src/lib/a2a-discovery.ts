// A2A Discovery — outbound agent card fetch with schema validation + cache.
//
// discoverAgent(domain) fetches /.well-known/agent-card.json from an external
// A2A peer, validates the minimum required schema fields, and returns an
// AgentCard or null (fail-soft). Results are cached in-memory for 5 minutes.
//
// Schema validated: name, url, version, skills[], x-agentIdentity.jwksUrl.
// Any field missing → return null (not throw). Callers use null as "unknown".

import { cloudLog } from "@/lib/cloud-logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PeerAgentSkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
  examples?: string[];
}

export interface PeerAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  version: string;
  skills: PeerAgentSkill[];
  "x-agentIdentity"?: {
    kid: string;
    algorithm: string;
    curve: string;
    jwksUrl: string;
  };
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
  };
}

// ── In-memory cache ───────────────────────────────────────────────────────────

interface CacheEntry {
  card: PeerAgentCard;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min
const DISCOVERY_TIMEOUT_MS = 5_000;

// module-level cache — survives across requests in the same instance.
const cache = new Map<string, CacheEntry>();

// ── Schema validation ─────────────────────────────────────────────────────────

function isValidAgentCard(raw: unknown): raw is PeerAgentCard {
  if (!raw || typeof raw !== "object") return false;
  const c = raw as Record<string, unknown>;
  if (typeof c["name"] !== "string" || !c["name"]) return false;
  if (typeof c["url"] !== "string" || !c["url"]) return false;
  if (typeof c["version"] !== "string" || !c["version"]) return false;
  if (!Array.isArray(c["skills"])) return false;

  // x-agentIdentity with jwksUrl is required for peer trust
  const identity = c["x-agentIdentity"];
  if (!identity || typeof identity !== "object") return false;
  const id = identity as Record<string, unknown>;
  if (typeof id["jwksUrl"] !== "string" || !id["jwksUrl"]) return false;

  return true;
}

// ── Fetch with timeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Discover an external A2A agent by domain/path-domain.
 *
 * - Fetches /.well-known/agent-card.json (or /agent-card for path-domain style).
 * - Validates minimum A2A v0.3.0 schema including x-agentIdentity.jwksUrl.
 * - Caches valid results for 5 minutes.
 * - Returns null on timeout, 404, schema error, or network failure (fail-soft).
 *
 * @param domain e.g. "distribuidora-mendoza.com.ar" or
 *               "somosvelora.com/api/peers/distribuidora-mendoza"
 */
export async function discoverAgent(domain: string): Promise<PeerAgentCard | null> {
  const now = Date.now();
  const cached = cache.get(domain);
  if (cached && cached.expiresAt > now) {
    return cached.card;
  }

  // Build the well-known URL. Path-domain style (e.g. host/subpath) gets a
  // /agent-card suffix; plain domain gets the canonical /.well-known path.
  const base = domain.startsWith("http") ? domain : `https://${domain}`;
  const isPathDomain = base.split("/").length > 3; // has path component after host
  const url = isPathDomain
    ? `${base}/agent-card`
    : `${base}/.well-known/agent-card.json`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, DISCOVERY_TIMEOUT_MS);
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_DISCOVERY_FETCH_FAILED",
      a2a_transfer: false,
      message: `Peer discovery fetch failed for ${domain}`,
      data: { domain, error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }

  if (!res.ok) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_DISCOVERY_HTTP_ERROR",
      a2a_transfer: false,
      message: `Peer discovery returned HTTP ${res.status} for ${domain}`,
      data: { domain, status: res.status },
    });
    return null;
  }

  let raw: unknown;
  try {
    raw = await res.json();
  } catch {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_DISCOVERY_JSON_ERROR",
      a2a_transfer: false,
      message: `Peer discovery returned invalid JSON for ${domain}`,
      data: { domain },
    });
    return null;
  }

  if (!isValidAgentCard(raw)) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_DISCOVERY_SCHEMA_INVALID",
      a2a_transfer: false,
      message: `Peer agent card schema validation failed for ${domain}`,
      data: { domain },
    });
    return null;
  }

  const card = raw as PeerAgentCard;
  cache.set(domain, { card, expiresAt: now + CACHE_TTL_MS });
  return card;
}

/** Evict a domain from the discovery cache (useful after addTrustedPeer). */
export function evictDiscoveryCache(domain: string): void {
  cache.delete(domain);
}
