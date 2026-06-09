// Circuit breaker for OCA API calls (quote, create, track).
//
// Uses opossum (IBM/Nodeshift, ~735k weekly downloads) — the canonical Node.js
// circuit breaker library. Version 9.0.0+ requires Node 20+ and aligns with
// the WHATWG Fetch API used throughout this codebase.
//
// This is the canonical opossum-based pattern for Velora courier adapters.
// TODO: migrate andreani-circuit.ts to opossum (currently homegrown DB-backed CB)
//       using this file as the reference implementation — tracked in audit finding #3.
//
// Config (tuned for OCA e-Pak + ApiPostal latency profile):
//   timeout              10s — OCA HTTP_TIMEOUT_MS is 12s; CB fires just before.
//   errorThresholdPercentage 50 — open after 50% of requests in sample window fail.
//   volumeThreshold      3  — minimum requests before CB can open (small traffic on inactive OCA).
//   resetTimeout         30s — HALF-OPEN probe after 30 s in OPEN state.
//
// Action codes emitted on state transitions (used by cloudLog callers in oca-adapter.ts):
//   OCA_CIRCUIT_OPEN       — circuit tripped; all calls fast-fail until resetTimeout.
//   OCA_CIRCUIT_HALF_OPEN  — probe period started; one request allowed through.
//   OCA_CIRCUIT_CLOSE      — recovery confirmed; normal operations resumed.
//   OCA_CIRCUIT_FALLBACK   — a call was served by the fallback (circuit was open).

import CircuitBreaker from "opossum";
import { cloudLog } from "@/lib/cloud-logger";

// ── Circuit breaker config ────────────────────────────────────────────────────

const CB_OPTIONS: CircuitBreaker.Options = {
  timeout:                  10_000,  // ms — fires before OCA's own 12s AbortController
  errorThresholdPercentage: 50,      // open when ≥50% of calls fail within the rolling window
  volumeThreshold:          3,       // need ≥3 calls before the breaker can open
  resetTimeout:             30_000,  // ms — try HALF-OPEN after 30s in OPEN state
};

// ── Singleton CB factory ──────────────────────────────────────────────────────

// One CircuitBreaker instance per async function wraps all OCA outbound calls.
// We use a single breaker (not per-operation) because OCA's underlying infra
// (e-Pak endpoint + ApiPostal) share the same reliability envelope — if one
// operation is failing, the others will too.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- opossum generic requires any[] for action args
let _breaker: CircuitBreaker<any[], unknown> | null = null;

/**
 * Returns the singleton OCA circuit breaker, creating it on first call.
 * The breaker wraps an async function passed at call time via `fire()`.
 */
function getBreaker(): CircuitBreaker {
  if (_breaker) return _breaker;

  // Wrap a generic async thunk: () => Promise<T>.
  // Callers pass the actual OCA fetch as the argument to fire().
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _breaker = new CircuitBreaker((fn: () => Promise<any>) => fn(), CB_OPTIONS);

  _breaker.on("open", () => {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "OCA_CIRCUIT_OPEN",
      a2a_transfer: false,
      message: "OCA circuit breaker OPEN — fast-failing all OCA calls for 30s",
      data: { resetTimeoutMs: CB_OPTIONS.resetTimeout },
    });
  });

  _breaker.on("halfOpen", () => {
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "OCA_CIRCUIT_HALF_OPEN",
      a2a_transfer: false,
      message: "OCA circuit breaker HALF-OPEN — sending probe request",
      data: {},
    });
  });

  _breaker.on("close", () => {
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "OCA_CIRCUIT_CLOSE",
      a2a_transfer: false,
      message: "OCA circuit breaker CLOSE — OCA recovered, normal operations resumed",
      data: {},
    });
  });

  _breaker.on("fallback", (result: unknown) => {
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action: "OCA_CIRCUIT_FALLBACK",
      a2a_transfer: false,
      message: "OCA circuit breaker fallback triggered — returning degraded response",
      data: { fallbackResult: result },
    });
  });

  return _breaker;
}

// ── Fallback sentinel ─────────────────────────────────────────────────────────

/** Structured sentinel returned when the circuit is OPEN and calls are shed. */
export interface OcaCircuitOpenError {
  error: "oca_circuit_open";
  message: string;
}

function ocaCircuitOpenFallback(): OcaCircuitOpenError {
  return {
    error: "oca_circuit_open",
    message: "OCA temporalmente no disponible — intentá en 30 segundos",
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run an OCA async operation through the circuit breaker.
 *
 * @param fn  Zero-argument async thunk that performs the OCA HTTP call.
 * @returns   The result of fn(), or OcaCircuitOpenError when the circuit is open.
 *
 * @example
 * const result = await runWithOcaCircuit(() => fetchTarifas(params));
 * if (isOcaCircuitOpen(result)) { ... handle fast-fail ... }
 */
export async function runWithOcaCircuit<T>(fn: () => Promise<T>): Promise<T | OcaCircuitOpenError> {
  const breaker = getBreaker();
  breaker.fallback(ocaCircuitOpenFallback);
  // fire() returns T when the circuit allows the call through, or the fallback
  // sentinel when the circuit is OPEN or the call times out / throws.
  return (await breaker.fire(fn)) as T | OcaCircuitOpenError;
}

/**
 * Type guard — returns true when runWithOcaCircuit returned the open-circuit sentinel.
 */
export function isOcaCircuitOpen(result: unknown): result is OcaCircuitOpenError {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as OcaCircuitOpenError).error === "oca_circuit_open"
  );
}
