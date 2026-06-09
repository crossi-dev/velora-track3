// Circuit breaker for Andreani API calls (createOrden, fetchTarifas, fetchTracking).
//
// Uses opossum (IBM/Nodeshift, ~735k weekly downloads) — the canonical Node.js
// circuit breaker library. Mirrors the reference implementation in
// src/app/api/agents/logistica/jsonrpc/_lib/providers/oca-circuit.ts exactly,
// satisfying the TODO in that file (audit finding #3).
//
// Config (tuned for Andreani REST API latency profile):
//   timeout              10s — fires before Andreani's own 12s AbortController.
//   errorThresholdPercentage 50 — open after 50% of requests in sample window fail.
//   volumeThreshold      3  — minimum requests before CB can open (low traffic).
//   resetTimeout         30s — HALF-OPEN probe after 30 s in OPEN state.
//
// Action codes emitted on state transitions:
//   ANDREANI_CIRCUIT_OPEN      — circuit tripped; fast-failing all calls for 30s.
//   ANDREANI_CIRCUIT_HALF_OPEN — probe period started; one request allowed through.
//   ANDREANI_CIRCUIT_CLOSE     — recovery confirmed; normal operations resumed.
//   ANDREANI_CIRCUIT_FALLBACK  — a call was served by the fallback (circuit was open).

import CircuitBreaker from "opossum";
import { cloudLog } from "@/lib/cloud-logger";

// ── Circuit breaker config ────────────────────────────────────────────────────

const CB_OPTIONS: CircuitBreaker.Options = {
  timeout:                  10_000,  // ms — fires before Andreani's own 12s AbortController
  errorThresholdPercentage: 50,      // open when ≥50% of calls fail within the rolling window
  volumeThreshold:          3,       // need ≥3 calls before the breaker can open
  resetTimeout:             30_000,  // ms — try HALF-OPEN after 30s in OPEN state
};

// ── Singleton CB factory ──────────────────────────────────────────────────────

// One CircuitBreaker instance per process wraps all Andreani outbound calls.
// Single breaker (not per-operation) because Andreani's REST gateway shares
// the same reliability envelope — if one endpoint fails, the others will too.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- opossum generic requires any[] for action args
let _breaker: CircuitBreaker<any[], unknown> | null = null;

function getBreaker(): CircuitBreaker {
  if (_breaker) return _breaker;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _breaker = new CircuitBreaker((fn: () => Promise<any>) => fn(), CB_OPTIONS);

  // Register fallback once at construction — .fallback() replaces the handler
  // on every call, so registering per-fire() is wasteful and fragile.
  _breaker.fallback(andreaniCircuitOpenFallback);

  _breaker.on("open", () => {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "ANDREANI_CIRCUIT_OPEN",
      a2a_transfer: false,
      message: "Andreani circuit breaker OPEN — fast-failing all Andreani calls for 30s",
      data: { resetTimeoutMs: CB_OPTIONS.resetTimeout },
    });
  });

  _breaker.on("halfOpen", () => {
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "ANDREANI_CIRCUIT_HALF_OPEN",
      a2a_transfer: false,
      message: "Andreani circuit breaker HALF-OPEN — sending probe request",
      data: {},
    });
  });

  _breaker.on("close", () => {
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "ANDREANI_CIRCUIT_CLOSE",
      a2a_transfer: false,
      message: "Andreani circuit breaker CLOSE — Andreani recovered, normal operations resumed",
      data: {},
    });
  });

  _breaker.on("fallback", (result: unknown) => {
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "ANDREANI_CIRCUIT_FALLBACK",
      a2a_transfer: false,
      message: "Andreani circuit breaker fallback triggered — returning degraded response",
      data: { fallbackResult: result },
    });
  });

  return _breaker;
}

// ── Fallback sentinel ─────────────────────────────────────────────────────────

/** Structured sentinel returned when the circuit is OPEN and calls are shed. */
export interface AndreaniCircuitOpenError {
  error: "andreani_circuit_open";
  message: string;
}

function andreaniCircuitOpenFallback(): AndreaniCircuitOpenError {
  return {
    error: "andreani_circuit_open",
    message: "Andreani temporalmente no disponible — intentá en 30 segundos",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run an Andreani async operation through the circuit breaker.
 *
 * @param fn  Zero-argument async thunk that performs the Andreani HTTP call.
 * @returns   The result of fn(), or AndreaniCircuitOpenError when the circuit is open.
 *
 * @example
 * const result = await runWithAndreaniCircuit(() => createOrden(payload, ctx));
 * if (isAndreaniCircuitOpen(result)) { ... handle fast-fail ... }
 */
export async function runWithAndreaniCircuit<T>(fn: () => Promise<T>): Promise<T | AndreaniCircuitOpenError> {
  const breaker = getBreaker();
  return (await breaker.fire(fn)) as T | AndreaniCircuitOpenError;
}

/**
 * Type guard — returns true when runWithAndreaniCircuit returned the open-circuit sentinel.
 */
export function isAndreaniCircuitOpen(result: unknown): result is AndreaniCircuitOpenError {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as AndreaniCircuitOpenError).error === "andreani_circuit_open"
  );
}
