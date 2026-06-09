// supervisor-semantic-circuit.ts
// Per-tenant soft circuit breaker for LLM semantic degradation.
//
// Tracks LLM degradation failures (empty answer, JSON parse fail, hallucination
// guard rejection) separately from infrastructure failures. These return HTTP 200
// but signal model instability.
//
// Thresholds:
//   SEMANTIC_FAILURE_THRESHOLD = 3 within rolling SEMANTIC_WINDOW_MS (60 s)
//   Effect: route future calls to Gemini Flash directly (soft degraded mode).
//   Recovery: automatic — once all timestamps fall outside the 60 s window,
//   the soft circuit closes on the next request with zero semantic failures.
//
// This does NOT open the hard circuit (which sheds load entirely). It degrades
// gracefully: Flash answers are lower quality but available.
//
// H-4 fix: the circuit is keyed per-businessId (Map<string, SemanticCircuit>)
// so one tenant's bad prompts cannot degrade Pro routing for all others.
// Idle entries (no timestamps within the eviction window) are pruned on each
// write to prevent unbounded Map growth.

import { cloudLog } from "@/lib/cloud-logger";

const SEMANTIC_FAILURE_THRESHOLD = 3;
const SEMANTIC_WINDOW_MS = 60_000;
// Entries with no recent timestamps are evicted after this margin beyond the
// rolling window. 2× the window gives stragglers time to expire naturally.
const SEMANTIC_EVICTION_MARGIN_MS = SEMANTIC_WINDOW_MS * 2;

interface SemanticCircuit {
  /** Rolling window of semantic failure timestamps (ms). */
  timestamps: number[];
  /** True when the soft circuit is open — route to Flash. */
  softOpen: boolean;
}

/** Per-tenant semantic circuit state. Keyed by businessId. */
const semanticCircuits = new Map<string, SemanticCircuit>();

/** Return the existing entry for bizId or create an empty one. */
function getOrCreateSemanticCircuit(bizId: string): SemanticCircuit {
  let entry = semanticCircuits.get(bizId);
  if (!entry) {
    entry = { timestamps: [], softOpen: false };
    semanticCircuits.set(bizId, entry);
  }
  return entry;
}

/**
 * Evict Map entries whose most-recent timestamp is older than
 * SEMANTIC_EVICTION_MARGIN_MS (i.e., the entry has been idle long enough
 * that even if it had been open, it would have auto-recovered).
 * Called on every write to keep the Map bounded.
 */
function evictIdleSemanticEntries(): void {
  const cutoff = Date.now() - SEMANTIC_EVICTION_MARGIN_MS;
  for (const [key, entry] of semanticCircuits) {
    const lastTs = entry.timestamps.at(-1) ?? 0;
    if (lastTs < cutoff) {
      semanticCircuits.delete(key);
    }
  }
}

/**
 * Record a semantic degradation failure for the given business.
 * Semantic failures: empty answer, JSON parse fail, hallucination guard rejection.
 *
 * After SEMANTIC_FAILURE_THRESHOLD within SEMANTIC_WINDOW_MS, sets the tenant's
 * softOpen = true so the runner can route to Flash.
 */
export function recordSemanticFailure(bizId: string): void {
  // jd CONFIRMED-2: an empty bizId (unauthenticated/anonymous fallback) would
  // share a single "" bucket across all such calls — a narrower replay of the
  // cross-tenant bleed this fix exists to prevent. Don't track circuits for it.
  if (!bizId) return;
  evictIdleSemanticEntries();

  const now = Date.now();
  const circuit = getOrCreateSemanticCircuit(bizId);

  // Purge stale timestamps outside the rolling window before counting.
  circuit.timestamps = circuit.timestamps.filter((t) => now - t < SEMANTIC_WINDOW_MS);
  circuit.timestamps.push(now);

  const count = circuit.timestamps.length;
  if (count >= SEMANTIC_FAILURE_THRESHOLD && !circuit.softOpen) {
    circuit.softOpen = true;
    cloudLog({
      severity: "WARNING",
      component: "Supervisor",
      action: "SUPERVISOR_SEMANTIC_CIRCUIT_OPEN",
      a2a_transfer: false,
      message: `Semantic circuit opened after ${count} semantic failures in ${SEMANTIC_WINDOW_MS / 1000}s window — routing to Flash`,
      businessId: bizId,
      data: { count, windowMs: SEMANTIC_WINDOW_MS, threshold: SEMANTIC_FAILURE_THRESHOLD },
    });
  }
}

/**
 * Check whether the semantic soft circuit is currently open for the given tenant.
 * Also auto-recovers: if the rolling window has no failures, closes the circuit.
 */
export function semanticCircuitIsOpen(bizId: string): boolean {
  if (!bizId) return false;
  const circuit = semanticCircuits.get(bizId);
  if (!circuit || !circuit.softOpen) return false;

  const now = Date.now();
  // Auto-recover: all timestamps may have expired since the circuit opened.
  circuit.timestamps = circuit.timestamps.filter((t) => now - t < SEMANTIC_WINDOW_MS);
  if (circuit.timestamps.length < SEMANTIC_FAILURE_THRESHOLD) {
    circuit.softOpen = false;
    // jd CONFIRMED-1: the entry is now dead ([], closed). Remove it so a tenant
    // that fails then goes silent doesn't linger in the Map until some other
    // tenant's write triggers eviction (read-path memory accumulation).
    semanticCircuits.delete(bizId);
    return false;
  }
  return true;
}
