// andreani-preflight.ts — Validates Andreani client_id + client_secret against
// the REAL Andreani production API before credentials are encrypted and persisted.
//
// The platform is always in production mode (ANDREANI_PRODUCTION=true).
// We hit the production endpoint unconditionally — no sandbox fallback here.
//
// On success: returns void.
// On rejection by Andreani: throws AndreaniPreflightError with a Spanish message.
// On network timeout: throws AndreaniPreflightError with a "try again" message.
//
// SECURITY: clientSecret is NEVER logged, returned, or included in error messages.

// Correct REST API host (plural — api.andreani.com is the legacy IBM SOAP server).
const ANDREANI_PROD_BASE = "https://apis.andreani.com";
const AUTH_TIMEOUT_MS = 12_000; // 12 s

// ── Typed error ───────────────────────────────────────────────────────────────

export class AndreaniPreflightError extends Error {
  /** Human-readable Spanish message — safe to surface to the owner. */
  readonly spanishMessage: string;
  /** Whether the failure is transient (network/timeout) vs credential-related. */
  readonly transient: boolean;

  constructor(spanishMessage: string, transient = false) {
    super(spanishMessage);
    this.name = "AndreaniPreflightError";
    this.spanishMessage = spanishMessage;
    this.transient = transient;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempts a real Andreani authentication using the provided credentials
 * against the production endpoint. Throws AndreaniPreflightError on failure.
 *
 * SECURITY: clientSecret is never included in any log or error message.
 */
export async function validateAndreaniCreds(
  clientId: string,
  clientSecret: string,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${ANDREANI_PROD_BASE}/v2/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Only clientId and clientSecret are sent — safe: secret goes over TLS only.
      body: JSON.stringify({ usuario: clientId, password: clientSecret }),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("abort") || msg.includes("Timeout") || msg.includes("ECONNRESET")) {
      throw new AndreaniPreflightError(
        "No pudimos verificar las credenciales con Andreani en este momento (tiempo de espera agotado). " +
        "Probá de nuevo en unos segundos.",
        true,
      );
    }
    throw new AndreaniPreflightError(
      "No pudimos conectarnos con Andreani para verificar las credenciales. Probá de nuevo.",
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.ok) return; // 200 — credentials are valid, token is irrelevant here.

  // Classify known HTTP status codes for actionable Spanish messages.
  if (res.status === 401 || res.status === 403) {
    throw new AndreaniPreflightError(
      "Andreani rechazó esas credenciales. Verificá el client_id y el client_secret, " +
      "y que tu cuenta esté activa.",
    );
  }

  if (res.status === 404) {
    throw new AndreaniPreflightError(
      "El endpoint de autenticación de Andreani no fue encontrado. " +
      "Contactá a soporte de Velora.",
      true,
    );
  }

  if (res.status >= 500) {
    throw new AndreaniPreflightError(
      "Andreani está respondiendo con un error de servidor. Probá de nuevo en unos minutos.",
      true,
    );
  }

  // Unknown non-2xx response.
  throw new AndreaniPreflightError(
    `Andreani devolvió un error inesperado (HTTP ${res.status}). Probá de nuevo.`,
    true,
  );
}
