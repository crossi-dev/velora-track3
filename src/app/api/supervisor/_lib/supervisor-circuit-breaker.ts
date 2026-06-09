// supervisor-circuit-breaker.ts
// In-memory + DB-backed circuit breaker for the Supervisor LLM path.
//
// REL-CIRCUIT-BREAKER: Google Cloud WAF 2026 AI/ML reliability perspective
// requires circuit-breaker + fallback pattern for LLM-backed routes.
//
// State machine: CLOSED → OPEN (on N consecutive non-retriable failures) → HALF_OPEN (after cooldown).
//
// REG-1 fix: The process-local state is kept as the fast path; a Postgres row
// (keyed "supervisor-circuit" in RateLimitBucket) acts as the fleet-wide
// coordination layer so OPEN state propagates across Cloud Run instances.
//
// Thresholds:
//   CB_FAILURE_THRESHOLD = 3  failures within CB_FAILURE_WINDOW_MS before opening
//   CB_FAILURE_WINDOW_MS  = 120s rolling window — failures outside the window are
//                           pruned before the threshold check so a single burst
//                           long ago does not permanently inflate the count
//   CB_RECOVERY_TIMEOUT_MS = 30s half-open probe window

import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";

const CB_FAILURE_THRESHOLD = 3;
// Rolling window for the hard circuit. Failures older than this are pruned
// before counting, mirroring the pattern used by supervisorSemanticCircuit.
const CB_FAILURE_WINDOW_MS = 120_000; // 2 minutes
export const CB_RECOVERY_TIMEOUT_MS = 30_000;

// DB circuit key — uses RateLimitBucket as a lightweight KV store.
// tokens field stores the openedAt timestamp (ms) when OPEN, 0 when CLOSED.
const DB_KEY = "supervisor-circuit";

type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreaker {
  state: CircuitState;
  /** Rolling window of infrastructure failure timestamps (ms). Replaces monotonic failureCount. */
  failureTimestamps: number[];
  openedAt: number | null;
  halfOpenProbeAllowed: boolean;
}

export const supervisorCircuit: CircuitBreaker = {
  state: "CLOSED",
  failureTimestamps: [],
  openedAt: null,
  halfOpenProbeAllowed: true,
};

// ── DB-backed fleet state helpers ─────────────────────────────────────────────

/** Write OPEN state to DB so all instances can detect it. Fire-and-forget. */
function writeDbCircuitOpen(openedAtMs: number): void {
  const now = new Date();
  void prisma.rateLimitBucket.upsert({
    where: { key: DB_KEY },
    // capacity/refillRate/lastRefillAt are token-bucket fields repurposed here:
    // tokens = openedAt ms, capacity = 1 (sentinel), refillRate = 0.
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

// SEC-T3-CRIT-1: allowed clock skew into the future for the openedAt timestamp.
// Full lower bound is computed dynamically inside circuitAllowsRequestFleet.
const CB_TOKENS_MAX_SKEW_MS = 60_000; // allow 60 s of clock skew into the future

// SEC-T3-HIGH-4: per-instance cache of the last successfully read fleet CB state.
// On DB error circuitAllowsRequestFleet returns this cached value instead of
// blindly returning true (fail-open). TTL = 5 s so a transient DB outage degrades
// gracefully (uses last known state) without permanently blocking recovery.
const CB_FLEET_CACHE_TTL_MS = 5_000;
let _fleetCacheValue = true; // default allow until we have a real reading
let _fleetCacheAt = 0;

/**
 * Read fleet-wide circuit state from DB.
 * Returns true (allow) if the DB row is absent, closed, or the open window expired.
 * Returns false (shed) if a sibling instance opened the circuit recently.
 * Fail-open on DB error — process-local state is authoritative if DB unreachable.
 *
 * SEC-T3-CRIT-1: validate that tokens is within a plausible timestamp range before
 * treating it as an openedAt value. A poisoned row with tokens = 9999999999999 would
 * hold the circuit permanently OPEN across the entire fleet; reject + log + fall back.
 */
export async function circuitAllowsRequestFleet(): Promise<boolean> {
  try {
    const row = await prisma.rateLimitBucket.findUnique({ where: { key: DB_KEY }, select: { tokens: true } });
    const now = Date.now();

    let result: boolean;
    if (!row || row.tokens === 0) {
      result = true;
    } else {
      const openedAt = row.tokens; // stored as ms timestamp when OPEN

      // SEC-T3-CRIT-1: plausible range check — [now - 7 days, now + 60 s].
      const lowerBound = now - 7 * 24 * 60 * 60 * 1000;
      const upperBound = now + CB_TOKENS_MAX_SKEW_MS;
      if (openedAt < lowerBound || openedAt > upperBound) {
        cloudLog({
          severity: "WARNING",
          component: "Supervisor",
          action: "SUPERVISOR_CIRCUIT_POISONED_ROW",
          a2a_transfer: false,
          message: `CB row has implausible tokens value (${openedAt}) — ignoring and treating circuit as CLOSED`,
          data: { tokens: openedAt, lowerBound, upperBound },
        });
        result = true; // fall back to process-local CB
      } else {
        const elapsed = now - openedAt;
        result = elapsed >= CB_RECOVERY_TIMEOUT_MS;
      }
    }

    // SEC-T3-HIGH-4: persist the successful read into the per-instance cache.
    _fleetCacheValue = result;
    _fleetCacheAt = now;
    return result;
  } catch {
    // SEC-T3-HIGH-4: on DB error use the last known fleet state (max 5 s old)
    // instead of blindly returning true. An attacker who saturates pgbouncer
    // connections turns a naive fail-open into complete fleet CB bypass.
    const cacheAge = Date.now() - _fleetCacheAt;
    if (cacheAge <= CB_FLEET_CACHE_TTL_MS) {
      cloudLog({
        severity: "WARNING",
        component: "Supervisor",
        action: "SUPERVISOR_CIRCUIT_DB_ERROR_USING_CACHE",
        a2a_transfer: false,
        message: `circuitAllowsRequestFleet DB error — using cached fleet state (age ${cacheAge}ms)`,
        data: { cachedValue: _fleetCacheValue, cacheAge },
      });
      return _fleetCacheValue;
    }
    // Cache stale or no reading yet — fall back to allow (process-local CB active).
    return true;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Sync fast-path check (process-local). Callers must also await circuitAllowsRequestFleet(). */
export function circuitAllowsRequest(): boolean {
  if (supervisorCircuit.state === "CLOSED") return true;
  if (supervisorCircuit.state === "OPEN") {
    const elapsed = Date.now() - (supervisorCircuit.openedAt ?? 0);
    if (elapsed >= CB_RECOVERY_TIMEOUT_MS) {
      supervisorCircuit.state = "HALF_OPEN";
      supervisorCircuit.halfOpenProbeAllowed = true;
    } else {
      return false;
    }
  }
  if (supervisorCircuit.state === "HALF_OPEN") {
    if (supervisorCircuit.halfOpenProbeAllowed) {
      supervisorCircuit.halfOpenProbeAllowed = false;
      return true;
    }
    return false;
  }
  return true;
}

export function circuitOnSuccess(): void {
  supervisorCircuit.state = "CLOSED";
  supervisorCircuit.failureTimestamps = [];
  supervisorCircuit.openedAt = null;
  writeDbCircuitClosed();
}

// Semantic circuit is split to its own module to stay under the 300-line limit.
// Re-exported here so existing imports from supervisor-circuit-breaker still work.
export { recordSemanticFailure, semanticCircuitIsOpen } from "./supervisor-semantic-circuit";

export function circuitOnFailure(bizId: string): void {
  const now = Date.now();
  // Rolling window: prune failures older than CB_FAILURE_WINDOW_MS before counting.
  supervisorCircuit.failureTimestamps = supervisorCircuit.failureTimestamps.filter(
    (t) => now - t < CB_FAILURE_WINDOW_MS,
  );
  supervisorCircuit.failureTimestamps.push(now);
  const recentFailureCount = supervisorCircuit.failureTimestamps.length;

  if (recentFailureCount >= CB_FAILURE_THRESHOLD && supervisorCircuit.state === "CLOSED") {
    supervisorCircuit.state = "OPEN";
    supervisorCircuit.openedAt = now;
    writeDbCircuitOpen(supervisorCircuit.openedAt);
    cloudLog({
      severity: "ERROR",
      component: "Supervisor",
      action: "SUPERVISOR_CIRCUIT_OPEN",
      a2a_transfer: false,
      message: `Supervisor circuit OPENED after ${recentFailureCount} failures in ${CB_FAILURE_WINDOW_MS / 1000}s window — shedding load for ${CB_RECOVERY_TIMEOUT_MS / 1000}s`,
      businessId: bizId,
      data: { recentFailureCount, windowMs: CB_FAILURE_WINDOW_MS, recoveryMs: CB_RECOVERY_TIMEOUT_MS },
    });
  } else if (supervisorCircuit.state === "HALF_OPEN") {
    supervisorCircuit.state = "OPEN";
    supervisorCircuit.openedAt = now;
    supervisorCircuit.halfOpenProbeAllowed = false;
    writeDbCircuitOpen(supervisorCircuit.openedAt);
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "SUPERVISOR_CIRCUIT_REOPENED",
      a2a_transfer: false,
      message: "Supervisor half-open probe failed — circuit re-OPENED",
      businessId: bizId,
      data: { recoveryMs: CB_RECOVERY_TIMEOUT_MS },
    });
  }
}
