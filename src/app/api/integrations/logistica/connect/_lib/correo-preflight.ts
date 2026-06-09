// correo-preflight.ts — Validates Correo Argentino credentials against the
// MiCorreo production API before credentials are encrypted and persisted.
//
// Flow:
//   1. POST /Token with provided username+password → validates auth.
//   2. POST /Users/validate with the returned token → obtains customerId.
//   3. Return customerId on success so it can be embedded in credentials.
//
// On success:           returns CorreoPreflightResult { customerId }.
// On auth rejection:    throws CorreoPreflightError (not transient).
// On network/server error:  throws CorreoPreflightError (transient=true).
//
// SECURITY: password is NEVER logged, returned, or included in error messages.

const CORREO_API_BASE   = "https://api.correoargentino.com.ar/micorreo/v1";
const AUTH_TIMEOUT_MS   = 12_000;

// ── Typed error ───────────────────────────────────────────────────────────────

export class CorreoPreflightError extends Error {
  /** Human-readable Spanish message — safe to surface to the owner. */
  readonly spanishMessage: string;
  /** true = network/server issue (retry); false = credential problem (fix and retry). */
  readonly transient: boolean;

  constructor(spanishMessage: string, transient = false) {
    super(spanishMessage);
    this.name = "CorreoPreflightError";
    this.spanishMessage = spanishMessage;
    this.transient = transient;
  }
}

// ── Result shape ──────────────────────────────────────────────────────────────

export interface CorreoPreflightResult {
  /** customerId returned by POST /Users/validate — store in credentials. */
  customerId: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function postJson(
  path: string,
  body: unknown,
  token?: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  try {
    return await fetch(`${CORREO_API_BASE}${path}`, {
      method:  "POST",
      headers,
      body:    JSON.stringify(body),
      signal:  controller.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.toLowerCase().includes("abort") || msg.includes("ECONNRESET")) {
      throw new CorreoPreflightError(
        "No pudimos verificar las credenciales con Correo Argentino (tiempo de espera agotado). " +
        "Probá de nuevo en unos segundos.",
        true,
      );
    }
    throw new CorreoPreflightError(
      "No pudimos conectarnos con Correo Argentino para verificar las credenciales. Probá de nuevo.",
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}

function classifyHttpError(
  status: number,
  context: "token" | "validate",
): never {
  if (status === 401 || status === 403) {
    throw new CorreoPreflightError(
      "Correo Argentino rechazó esas credenciales. " +
      "Verificá el usuario y la contraseña de tu cuenta MiCorreo.",
    );
  }
  if (status === 404) {
    throw new CorreoPreflightError(
      `El endpoint de ${context === "token" ? "autenticación" : "validación"} de Correo Argentino no fue encontrado. ` +
      "Contactá a soporte de Velora.",
      true,
    );
  }
  if (status >= 500) {
    throw new CorreoPreflightError(
      "Correo Argentino está respondiendo con un error de servidor. Probá de nuevo en unos minutos.",
      true,
    );
  }
  throw new CorreoPreflightError(
    `Correo Argentino devolvió un error inesperado (HTTP ${status}). Probá de nuevo.`,
    true,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Validates Correo credentials against the production MiCorreo API.
 * Returns the customerId on success.
 *
 * SECURITY: password is never included in any log or error message.
 */
export async function validateCorreoCreds(
  username: string,
  password: string,
): Promise<CorreoPreflightResult> {

  // ── Step 1: POST /Token ──────────────────────────────────────────────────
  // SECURITY: password sent over TLS only.
  const tokenRes = await postJson("/Token", { username, password });

  if (!tokenRes.ok) {
    classifyHttpError(tokenRes.status, "token");
  }

  let tokenData: { access_token?: unknown };
  try {
    tokenData = (await tokenRes.json()) as typeof tokenData;
  } catch {
    throw new CorreoPreflightError(
      "Correo Argentino devolvió una respuesta inválida al autenticar. Probá de nuevo.",
      true,
    );
  }

  if (!tokenData.access_token || typeof tokenData.access_token !== "string") {
    throw new CorreoPreflightError(
      "Correo Argentino no devolvió un token de acceso válido. " +
      "Verificá las credenciales de tu cuenta MiCorreo.",
    );
  }

  const accessToken = tokenData.access_token;

  // ── Step 2: POST /Users/validate → get customerId ────────────────────────
  // Pass the token in the Authorization header; body may be empty or contain
  // the username depending on API version. We send username for robustness.
  const validateRes = await postJson("/Users/validate", { username }, accessToken);

  if (!validateRes.ok) {
    // A 401/403 here is unexpected (we just got a valid token), treat as transient.
    if (validateRes.status === 401 || validateRes.status === 403) {
      throw new CorreoPreflightError(
        "Correo Argentino no pudo validar el usuario con el token obtenido. Probá de nuevo.",
        true,
      );
    }
    classifyHttpError(validateRes.status, "validate");
  }

  let validateData: { customerId?: unknown };
  try {
    validateData = (await validateRes.json()) as typeof validateData;
  } catch {
    throw new CorreoPreflightError(
      "Correo Argentino devolvió una respuesta inválida al validar el usuario. Probá de nuevo.",
      true,
    );
  }

  const customerId =
    typeof validateData.customerId === "string" && validateData.customerId.trim()
      ? validateData.customerId.trim()
      : null;

  if (!customerId) {
    throw new CorreoPreflightError(
      "Correo Argentino no devolvió un customerId válido. " +
      "Verificá que tu cuenta MiCorreo esté activa y habilitada para API.",
    );
  }

  return { customerId };
}
