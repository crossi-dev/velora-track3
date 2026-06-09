// oca-preflight.ts — Validates OCA credentials against the REAL OCA ApiPostal
// production endpoint before credentials are encrypted and persisted.
//
// The platform is production-only (BYOA model — no sandbox path here).
// We call loginSigma on www1.oca.com.ar/ApiPostal/LoginController/loginSigma
// and classify the result:
//
// On success (HTTP 200, success=true, non-empty token): returns void.
// On auth rejection (401/403 or success=false):         throws OcaPreflightError (not transient).
// On network/server error (5xx / timeout):              throws OcaPreflightError (transient=true).
//
// SECURITY: password is NEVER logged, returned, or included in error messages.
//
// WARNING — URL STABILITY UNCONFIRMED FOR 2026:
//   The base URL "www1.oca.com.ar/ApiPostal" was confirmed at integration design time.
//   OCA has not published a stability commitment for this endpoint. If the URL changes,
//   all credential validation and subsequent shipment operations will fail.
//   Monitor Cloud Logging for OCA_APIPOSTAL_HEALTH_WARNING events (logged on first use).
//
// BLOCKED-EXTERNAL: cannot verify www1.oca.com.ar/ApiPostal canonicalidad for 2026
// without an OCA e-Pak merchant account. Velora runs OCA in mock mode in
// production today (no real OCA credentials). Schedule this verification step
// the same week any real OCA account is onboarded. Until then, the runtime
// OCA_APIPOSTAL_HEALTH_WARNING log (line 28+) flags drift if the URL stops
// responding.

import { cloudLog } from "@/lib/cloud-logger";

const OCA_APIPOSTAL_BASE = "https://www1.oca.com.ar/ApiPostal";
const AUTH_TIMEOUT_MS    = 12_000;

// ── Startup health-check ──────────────────────────────────────────────────────
// Performed once per cold start (module singleton). Issues a HEAD request to the
// login endpoint to verify reachability. A non-200 or redirect logs a WARNING to
// Cloud Logging so the ops team is notified without affecting the credential flow.

let _healthChecked = false;

async function _checkOcaEndpointHealth(): Promise<void> {
  if (_healthChecked) return;
  _healthChecked = true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(`${OCA_APIPOSTAL_BASE}/LoginController/loginSigma`, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "manual", // detect redirects without following them
    });
    clearTimeout(timer);
    // 405 = server reachable but doesn't support HEAD (expected). 200 = ok.
    if (res.status !== 200 && res.status !== 405) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "OCA_APIPOSTAL_HEALTH_WARNING",
        a2a_transfer: false,
        message: `OCA ApiPostal health-check: unexpected status=${res.status}. URL may have changed.`,
        data: { url: OCA_APIPOSTAL_BASE, status: res.status },
      });
    }
  } catch (err) {
    clearTimeout(timer);
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "OCA_APIPOSTAL_HEALTH_WARNING",
      a2a_transfer: false,
      message: "OCA ApiPostal health-check failed (network/timeout). URL may have changed.",
      data: { url: OCA_APIPOSTAL_BASE, error: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── Typed error ───────────────────────────────────────────────────────────────

export class OcaPreflightError extends Error {
  /** Human-readable Spanish message — safe to surface to the owner. */
  readonly spanishMessage: string;
  /** true = network/server issue (retry); false = credential problem (fix and retry). */
  readonly transient: boolean;

  constructor(spanishMessage: string, transient = false) {
    super(spanishMessage);
    this.name = "OcaPreflightError";
    this.spanishMessage = spanishMessage;
    this.transient = transient;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempts OCA ApiPostal loginSigma with the provided credentials.
 * Throws OcaPreflightError on failure.
 *
 * SECURITY: password is never included in any log or error message.
 */
export async function validateOcaCreds(
  usuario: string,
  password: string,
): Promise<void> {
  // Fire-and-forget health check on first use — result does not block validation.
  void _checkOcaEndpointHealth();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${OCA_APIPOSTAL_BASE}/LoginController/loginSigma`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // SECURITY: password sent over TLS only.
      body: JSON.stringify({ usuario, password }),
      signal: controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.includes("abort") || msg.includes("Timeout") || msg.includes("ECONNRESET")) {
      throw new OcaPreflightError(
        "No pudimos verificar las credenciales con OCA en este momento (tiempo de espera agotado). " +
        "Probá de nuevo en unos segundos.",
        true,
      );
    }
    throw new OcaPreflightError(
      "No pudimos conectarnos con OCA para verificar las credenciales. Probá de nuevo.",
      true,
    );
  } finally {
    clearTimeout(timer);
  }

  // HTTP-level failures.
  if (res.status === 401 || res.status === 403) {
    throw new OcaPreflightError(
      "OCA rechazó esas credenciales. Verificá el usuario y la contraseña " +
      "de tu cuenta OCA e-Pak, y que la cuenta esté activa.",
    );
  }

  if (res.status === 404) {
    throw new OcaPreflightError(
      "El endpoint de autenticación de OCA no fue encontrado. " +
      "Contactá a soporte de Velora.",
      true,
    );
  }

  if (res.status >= 500) {
    throw new OcaPreflightError(
      "OCA está respondiendo con un error de servidor. Probá de nuevo en unos minutos.",
      true,
    );
  }

  if (!res.ok) {
    throw new OcaPreflightError(
      `OCA devolvió un error inesperado (HTTP ${res.status}). Probá de nuevo.`,
      true,
    );
  }

  // HTTP 200 — parse body to confirm success=true and non-empty token.
  let data: { success?: boolean; message?: string; result?: unknown };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new OcaPreflightError(
      "OCA devolvió una respuesta inválida al verificar las credenciales. Probá de nuevo.",
      true,
    );
  }

  if (!data.success || typeof data.result !== "string" || !data.result) {
    // success=false typically means bad credentials at the application level.
    throw new OcaPreflightError(
      "OCA no autorizó esas credenciales. Verificá el usuario y la contraseña " +
      "de tu cuenta OCA e-Pak.",
    );
  }

  // Token is valid — credentials confirmed.
}
