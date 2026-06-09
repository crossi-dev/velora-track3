// OCA circuit breaker — opossum wrapper for all outbound OCA HTTP calls.
//
// Each named operation gets its own CircuitBreaker instance, reused across calls
// via the _circuits Map. The action delegate is a thin indirection that calls the
// currently-registered fn, so the CB state machine is shared across calls while
// each invocation supplies its own HTTP closure.
//
// Config mirrors production tolerances:
//   timeout              10 s   — OCA P95 latency is ~3 s; 10 s is the outer hard limit.
//   errorThresholdPercentage 50  — open after ≥50% errors in the rolling window.
//   resetTimeout         30 s   — half-open probe after 30 s.
//   rollingCountTimeout  60 s   — sliding window for error rate calculation.

import CircuitBreaker from "opossum";
import { cloudLog } from "@/lib/cloud-logger";

const CB_OPTIONS: ConstructorParameters<typeof CircuitBreaker>[1] = {
  timeout:                  10_000,
  errorThresholdPercentage: 50,
  resetTimeout:             30_000,
  rollingCountTimeout:      60_000,
};

interface CbEntry<T> {
  cb: CircuitBreaker;
  currentFn: (() => Promise<T>) | null;
}

// Cache: one entry per named operation.
const _circuits = new Map<string, CbEntry<unknown>>();

function getEntry<T>(name: string): CbEntry<T> {
  if (_circuits.has(name)) {
    return _circuits.get(name) as CbEntry<T>;
  }

  const entry: CbEntry<T> = { cb: null as unknown as CircuitBreaker, currentFn: null };

  // The action delegate reads from entry.currentFn so each fire() call invokes
  // the correct closure while sharing the CB state machine across calls.
  const cb = new CircuitBreaker(async () => {
    if (!entry.currentFn) throw new Error(`oca-circuit: no fn registered for "${name}"`);
    return entry.currentFn();
  }, CB_OPTIONS);

  entry.cb = cb;

  cb.on("open", () => {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action:    "OCA_CIRCUIT_OPEN",
      a2a_transfer: false,
      message:   `OCA circuit opened for "${name}" — failing fast until resetTimeout`,
      data:      { name },
    });
  });

  cb.on("halfOpen", () => {
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action:    "OCA_CIRCUIT_HALF_OPEN",
      a2a_transfer: false,
      message:   `OCA circuit half-open for "${name}" — probing`,
      data:      { name },
    });
  });

  cb.on("close", () => {
    cloudLog({
      severity: "INFO",
      component: "A2A",
      action:    "OCA_CIRCUIT_CLOSE",
      a2a_transfer: false,
      message:   `OCA circuit closed for "${name}" — resuming normal operation`,
      data:      { name },
    });
  });

  _circuits.set(name, entry as CbEntry<unknown>);
  return entry;
}

/**
 * Wrap an outbound OCA HTTP call in a named circuit breaker.
 *
 * @param name     Stable operation label, e.g. "oca.quote" or "oca.create".
 * @param fn       The async call to protect.
 * @param fallback Value returned when the circuit is open or the call fails.
 */
export async function withOcaCircuit<T>(
  name: string,
  fn: () => Promise<T>,
  fallback: T,
): Promise<T> {
  const entry = getEntry<T>(name);
  entry.currentFn = fn;
  entry.cb.fallback(() => fallback);
  try {
    return await (entry.cb.fire() as Promise<T>);
  } catch {
    return fallback;
  }
}
