// Edge-compatible employee session verification.
//
// Next.js middleware corre en Edge Runtime — NO tiene Node `crypto` (scrypt,
// createHmac, timingSafeEqual). Para que el middleware pueda detectar la
// cookie del empleado, exponemos acá una versión que usa Web Crypto API
// (disponible en Edge + Node).
//
// La firma de cookies (signEmployeeSession) y el hash de PIN (scrypt) viven
// en employee-auth.ts y son Node-only — solo se importan desde route handlers.

export const EMPLOYEE_COOKIE_NAME = "velora-employee-session";
export const EMPLOYEE_SESSION_REFRESH_THRESHOLD_MS = 30 * 60 * 1000; // 30 min

export interface EmployeeSessionPayload {
  employeeId: string;
  businessId: string;
  role: string;
  exp: number;
  sv: number; // session revocation counter — must match Employee.sessionVersion (parity with node-side EmployeeSessionPayload)
}

export interface VerifiedEmployeeSession {
  payload: EmployeeSessionPayload;
  shouldRefresh: boolean;
}

// RFC 5869 §3.1: fixed domain salt prevents extract-phase collapse when IKM
// has limited entropy. NOT secret, NOT rotated — its purpose is domain
// separation, not session uniqueness. Must match employee-auth.ts HKDF_SALT.
// Changing this value invalidates all derived keys (one-time re-login). Intentional.
const HKDF_SALT = new TextEncoder().encode("velora-hkdf-salt-v1");

// HKDF info label — must match employee-auth.ts EMPLOYEE_HKDF_INFO exactly.
const EMPLOYEE_HKDF_INFO = "velora-employee-session-v1";

/**
 * Derive an HMAC signing key via HKDF using Web Crypto (Edge-compatible).
 * Uses the same label + domain salt as the Node path (employee-auth.ts)
 * so both runtimes produce byte-identical keys for the same AUTH_SECRET. (C1+C2)
 */
async function deriveEmployeeKeyEdge(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const ikm = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: HKDF_SALT,
      info: encoder.encode(EMPLOYEE_HKDF_INFO),
    },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    [usage],
  );
}

/**
 * Verify employee session cookie using Web Crypto. Async porque
 * crypto.subtle.sign es async. Retorna null en cualquier error
 * (signature inválida, payload corrupto, expirado, AUTH_SECRET ausente).
 *
 * shouldRefresh = true when the session is valid but expires within
 * EMPLOYEE_SESSION_REFRESH_THRESHOLD_MS — signals callers to issue a new cookie.
 */
export async function verifyEmployeeSession(
  cookie: string | null | undefined
): Promise<VerifiedEmployeeSession | null> {
  if (!cookie || typeof cookie !== "string") return null;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;

  const dotIdx = cookie.indexOf(".");
  if (dotIdx <= 0 || dotIdx === cookie.length - 1) return null;
  const payloadB64 = cookie.slice(0, dotIdx);
  const signatureB64 = cookie.slice(dotIdx + 1);

  // HKDF-derived key with fixed domain salt (C1) — matches Node path exactly.
  // Legacy raw-secret and zero-salt fallbacks removed: all pre-existing sessions
  // are intentionally invalidated on first deploy (one-time re-login required).
  let expected = "";
  try {
    const encoder = new TextEncoder();
    const key = await deriveEmployeeKeyEdge(secret, "sign");
    const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
    expected = base64UrlEncode(new Uint8Array(sigBuf));
  } catch {
    return null;
  }

  if (!constantTimeEqual(signatureB64, expected)) {
    return null;
  }

  let parsed: EmployeeSessionPayload;
  try {
    parsed = JSON.parse(base64UrlDecodeUtf8(payloadB64));
  } catch {
    return null;
  }
  if (
    typeof parsed?.employeeId !== "string" ||
    !parsed.employeeId.trim() ||
    typeof parsed?.businessId !== "string" ||
    !parsed.businessId.trim() ||
    typeof parsed?.role !== "string" ||
    typeof parsed?.exp !== "number"
  ) {
    return null;
  }
  if (parsed.exp < Date.now()) return null;

  const shouldRefresh = parsed.exp - Date.now() < EMPLOYEE_SESSION_REFRESH_THRESHOLD_MS;
  return { payload: parsed, shouldRefresh };
}

/**
 * Sign an employee session payload using Web Crypto (Edge-compatible).
 * Used by middleware to issue refreshed cookies without Node `crypto`.
 * Key is derived via HKDF with the same label + domain salt as the Node
 * path (employee-auth.ts) — producing byte-identical keys. (C2 fix)
 * TTL is taken from the original payload's remaining duration, extended
 * by the standard 8-hour shift duration.
 */
export async function signEmployeeSessionEdge(
  payload: EmployeeSessionPayload,
  durationMs = 8 * 60 * 60 * 1000,
): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET missing");
  const fullPayload: EmployeeSessionPayload = { ...payload, exp: Date.now() + durationMs };
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(JSON.stringify(fullPayload));
  const payloadB64 = base64UrlEncode(jsonBytes);
  // HKDF-derived key — same derivation as verifyEmployeeSession and Node signEmployeeSession. (C2)
  const key = await deriveEmployeeKeyEdge(secret, "sign");
  const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  const signature = base64UrlEncode(new Uint8Array(sigBuf));
  return `${payloadB64}.${signature}`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecodeUtf8(s: string): string {
  const pad = (4 - (s.length % 4)) % 4;
  const std = (s + "=".repeat(pad)).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(std);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
