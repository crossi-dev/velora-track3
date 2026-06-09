// Circuit breaker state for Andreani API calls (quote, create, track).
// Extracted from andreani-adapter.ts to stay under the 300-line server/api cap.
//
// REL-N-6: extended from quote-only to all three Andreani operations so that
// a sustained Andreani outage triggers fast-fails on create and track instead
// of blocking for the full 12s HTTP timeout.
//
// HIGH-3-1: DB-backed fleet propagation added — mirrors the pattern from
// supervisor-circuit-breaker.ts so OPEN state propagates across all Cloud Run
// instances. Process-local state is the fast path; RateLimitBucket KV row
// (`andreani-circuit`) is the fleet coordination layer.

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";

export const CIRCUIT_FAILURE_THRESHOLD = 3;
export const CIRCUIT_HALF_OPEN_WINDOW_MS = 60_000; // 1 minute

type CircuitState = "closed" | "open" | "half-open";

export const circuit: { state: CircuitState; failures: number; openedAt: number } = {
  state: "closed",
  failures: 0,
  openedAt: 0,
};

// ── DB-backed fleet state helpers ─────────────────────────────────────────────

const DB_KEY = "andreani-circuit";

// SEC-T3-HIGH-4 (ported from supervisor-circuit-breaker.ts): per-instance cache
// of the last successfully read fleet CB state. On DB error circuitAllowsRequestFleet
// returns this cached value instead of blindly returning true (fail-open).
// TTL = 5 s so a transient DB outage degrades gracefully without permanently
// blocking recovery.
const CB_FLEET_CACHE_TTL_MS = 5_000;
let _fleetCacheValue = true; // default allow until we have a real reading
let _fleetCacheAt = 0;

/** Write OPEN state to DB so all instances can detect it. Fire-and-forget. */
function writeDbCircuitOpen(openedAtMs: number): void {
  const now = new Date();
  void prisma.rateLimitBucket.upsert({
    where: { key: DB_KEY },
    // tokens field repurposed as openedAt ms timestamp (capacity=1 sentinel, refillRate=0).
    create: { key: DB_KEY, tokens: openedAtMs, capacity: 1, refillRate: 0, lastRefillAt: now, updatedAt: now },
    update: { tokens: openedAtMs, updatedAt: now },
  }).catch(() => { /* non-fatal — process-local CB still works */ });
}

/** Clear OPEN state from DB on recovery. Fire-and-forget. */
function writeDbCircuitClosed(): void {
  const now = new Date();
  void prisma.rateLimitBucket.upsert({
    where: { key: DB_KEY },
    create: { key: DB_KEY, tokens: 0, capacity: 1, refillRate: 0, lastRefillAt: now, updatedAt: now },
    update: { tokens: 0, updatedAt: now },
  }).catch(() => { /* non-fatal */ });
}

/**
 * Read fleet-wide circuit state from DB.
 * Returns true (allow) if the DB row is absent, closed, or the open window expired.
 * Returns false (shed) if a sibling instance opened the circuit recently.
 *
 * REG-T3-ANDREANI-CB: uses a 5 s per-instance cache (ported from
 * supervisor-circuit-breaker.ts) so a DB error degrades gracefully to the last
 * known fleet state instead of blindly returning true (fail-open bypass).
 */
async function circuitAllowsRequestFleet(): Promise<boolean> {
  try {
    const row = await prisma.rateLimitBucket.findUnique({ where: { key: DB_KEY }, select: { tokens: true } });
    const now = Date.now();
    const result = !row || row.tokens === 0 ? true : now - row.tokens >= CIRCUIT_HALF_OPEN_WINDOW_MS;
    _fleetCacheValue = result;
    _fleetCacheAt = now;
    return result;
  } catch {
    const cacheAge = Date.now() - _fleetCacheAt;
    if (cacheAge <= CB_FLEET_CACHE_TTL_MS) return _fleetCacheValue;
    return true; // cache stale — fall back to allow (process-local CB active)
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Sync fast-path check (process-local only). */
function isCircuitOpenLocal(): boolean {
  if (circuit.state === "closed") return false;
  if (circuit.state === "open") {
    if (Date.now() - circuit.openedAt >= CIRCUIT_HALF_OPEN_WINDOW_MS) {
      circuit.state = "half-open";
      return false;
    }
    return true;
  }
  // half-open: allow one probe request through.
  return false;
}

/**
 * Async combined check: process-local fast path OR fleet DB state.
 * Returns true if the circuit should be treated as open (shed the request).
 */
export async function isCircuitOpen(): Promise<boolean> {
  if (isCircuitOpenLocal()) return true; // fast path: local already OPEN
  const fleetAllows = await circuitAllowsRequestFleet();
  if (!fleetAllows) {
    // Sibling opened the circuit — sync local state to OPEN.
    circuit.state = "open";
    circuit.openedAt = Date.now();
  }
  return !fleetAllows;
}

export function recordSuccess(): void {
  circuit.state = "closed";
  circuit.failures = 0;
  circuit.openedAt = 0;
  writeDbCircuitClosed();
}

export function recordFailure(op: string): void {
  circuit.failures += 1;
  if (circuit.state === "half-open" || circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.state = "open";
    circuit.openedAt = Date.now();
    writeDbCircuitOpen(circuit.openedAt);
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "LOGISTICA_ANDREANI_CIRCUIT_OPEN",
      a2a_transfer: false,
      message: `Andreani circuit breaker OPEN after ${circuit.failures} consecutive failures on ${op} — skipping for ${CIRCUIT_HALF_OPEN_WINDOW_MS / 1000}s`,
      data: { failures: circuit.failures, op },
    });
  }
}
