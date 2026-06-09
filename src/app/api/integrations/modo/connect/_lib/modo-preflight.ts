// MODO pre-flight credential validator.
//
// Called between shape validation and persist in the connect route.
// Makes a real auth call to MODO's /middleman/token endpoint.
// 401/403 → non-transient error (bad credentials).
// 5xx/timeout/network → transient error (retry later).
// NEVER logs or returns credential plaintext.

import { getModoToken, MODO_TOKEN_NETWORK_ERROR } from "../../_lib/modo-api-helpers";
import type { ModoCredentials } from "../../_lib/modo-api-helpers";

export class ModoPreflightError extends Error {
  readonly spanishMessage: string;
  /** true = transient (network/server), false = permanent (bad creds) */
  readonly transient: boolean;

  constructor(spanishMessage: string, transient = false) {
    super(spanishMessage);
    this.name = "ModoPreflightError";
    this.spanishMessage = spanishMessage;
    this.transient = transient;
  }
}

/**
 * Attempts a real auth call to MODO to validate credentials.
 * Throws ModoPreflightError on failure; resolves silently on success.
 * The fetchImpl parameter is injectable for testing (avoids network calls in tests).
 */
export async function validateModoCreds(
  creds: ModoCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  // We use a synthetic businessId for the preflight token cache entry.
  // This is intentional: the real businessId is not yet known at validation time
  // (the connect route has it, but we don't want to pollute the prod cache).
  const syntheticKey = `__preflight__${creds.clientId}`;

  let token: string | typeof MODO_TOKEN_NETWORK_ERROR | null;
  try {
    // Pass fetchImpl so tests can inject a mock without needing module-level mocks.
    token = await getModoToken(syntheticKey, creds, fetchImpl);
  } catch (err) {
    // Any unexpected error (getModoToken throws only on programming errors — it catches
    // network errors internally and returns MODO_TOKEN_NETWORK_ERROR). Treat as transient.
    throw new ModoPreflightError(
      "No se pudo verificar la credencial MODO. El servicio puede estar temporalmente no disponible. Intentá de nuevo en unos minutos.",
      true,
    );
  }

  if (token === MODO_TOKEN_NETWORK_ERROR) {
    // Network error or timeout — transient (not a credential problem).
    throw new ModoPreflightError(
      "No se pudo conectar con MODO. El servicio puede estar temporalmente no disponible. Intentá de nuevo en unos minutos.",
      true,
    );
  }

  if (!token) {
    // getModoToken returns null on 401/403 or bad response shape.
    // Non-transient — ask the user to re-check their credentials.
    throw new ModoPreflightError(
      "MODO rechazó las credenciales. Verificá que el Client ID, Client Secret y Store ID sean correctos.",
      false,
    );
  }

  // Token obtained — credentials are valid. Clean up the preflight cache entry
  // so it doesn't linger with stale or test data.
  // (The real businessId will get its own cache entry on first payment call.)
  // Note: we don't expose the cache directly — the preflight entry will expire
  // naturally via JWT exp. This is acceptable for the low-frequency connect flow.
}
