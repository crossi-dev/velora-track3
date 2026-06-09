// PERF-T3-5: per-businessId session service cache.
// createSessionServiceWithFallback constructs a new service object on every
// invocation. Since the session service holds no mutable per-request state,
// the same instance is safe to reuse across calls within the TTL window.
// 90s TTL mirrors the business context cache; LRU cap at 100 entries prevents
// unbounded growth across Cloud Run instances serving many tenants.

// Fix (2026-05-28): switched from createSessionServiceWithFallback to createSessionService.
// createSessionServiceWithFallback uses a dynamic require("./agent-engine-session-service")
// that webpack minifies into r() where r ends up undefined at runtime — the same
// "r is not a function" prod error observed on the customer-agent path.
// USE_AGENT_ENGINE_SESSIONS is false in prod; the fallback always returned
// ChatMessageSessionService anyway, so this is a safe no-op for the common path.
// When Agent Engine Sessions are ready to flip, revisit this file.
import { createSessionService } from "./session-service";

const TTL_MS = 90_000;
const MAX_ENTRIES = 100;

interface Entry {
  service: ReturnType<typeof createSessionService>;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

export function getCachedSessionService(
  businessId: string,
  agentName: string = "velora_supervisor",
): ReturnType<typeof createSessionService> {
  // Cache key includes agentName: a Supervisor session and an employee session for the
  // same businessId must use separate service instances (different event.author values).
  const cacheKey = `${businessId}:${agentName}`;
  const now = Date.now();
  const entry = cache.get(cacheKey);
  if (entry && entry.expiresAt > now) return entry.service;
  // LRU eviction: Map preserves insertion order; oldest key evicted first.
  if (cache.size >= MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  const service = createSessionService(businessId, agentName);
  cache.set(cacheKey, { service, expiresAt: now + TTL_MS });
  return service;
}
