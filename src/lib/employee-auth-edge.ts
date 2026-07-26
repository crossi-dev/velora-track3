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

// Idle timeout (task #15): a shared/POS terminal must not stay authenticated
// all day just because *some* request landed once every ~7.5h — that only
// protects against the cookie's absolute exp. This is a second, independent
// clock: no activity for EMPLOYEE_IDLE_TIMEOUT_MS means "walked away from an
// unlocked register," even though the 8h absolute exp is nowhere near firing.
// 30 min is the typical POS/register idle-lock convention. Business has no
// existing configurable field for this (checked prisma/schema.prisma) so it's
// a fixed constant rather than a per-business override, matching the scope of
// this change. Must match IDLE_TIMEOUT_MS in employee-auth.ts.
export const EMPLOYEE_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min

// How often an active session's lastActivity gets re-stamped into a fresh
// cookie. Re-signing on literally every request would work too (HMAC sign is
// cheap, no DB round-trip) but churns a Set-Cookie header onto every response.
// Refreshing every 5 min keeps lastActivity accurate to within 5 min, which is
// precise enough against a 30 min idle window.
export const EMPLOYEE_IDLE_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 min

export interface EmployeeSessionPayload {
  employeeId: string;
  businessId: string;
  role: string;
  exp: number;
  sv: number; // session revocation counter — must match Employee.sessionVersion (parity with node-side EmployeeSessionPayload)
  // Wall-clock time (ms) of the last request that passed session verification.
  // Optional for backward compat: cookies signed before this field existed
  // (2026-07-26) won't have it. Those are grandfathered — idle-checked only
  // once they carry a lastActivity value (see verifyEmployeeSession below) —
  // rather than force-expiring every mid-shift POS session on deploy.
  lastActivity?: number;
}

export interface VerifiedEmployeeSession {
  payload: EmployeeSessionPayload;
  shouldRefresh: boolean;
  // true  = refresh should slide the absolute exp forward (near-expiry case,
  //         existing behavior).
  // false = refresh should only re-stamp lastActivity; exp is left untouched
  //         so idle-activity refreshes can never extend the 8h absolute cap.
  extendExpiry: boolean;
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

  // Idle timeout: reject even though the absolute exp hasn't been reached
  // yet if the session has had no activity for EMPLOYEE_IDLE_TIMEOUT_MS.
  // lastActivity is optional (see EmployeeSessionPayload) — cookies without
  // it predate this field and are not idle-checked until they next refresh.
  if (
    typeof parsed.lastActivity === "number" &&
    Date.now() - parsed.lastActivity > EMPLOYEE_IDLE_TIMEOUT_MS
  ) {
    return null;
  }

  const nearExpiry = parsed.exp - Date.now() < EMPLOYEE_SESSION_REFRESH_THRESHOLD_MS;
  const idleStale =
    typeof parsed.lastActivity !== "number" ||
    Date.now() - parsed.lastActivity > EMPLOYEE_IDLE_REFRESH_INTERVAL_MS;
  const shouldRefresh = nearExpiry || idleStale;
  return { payload: parsed, shouldRefresh, extendExpiry: nearExpiry };
}

/**
 * Sign an employee session payload using Web Crypto (Edge-compatible).
 * Used by middleware to issue refreshed cookies without Node `crypto`.
 * Key is derived via HKDF with the same label + domain salt as the Node
 * path (employee-auth.ts) — producing byte-identical keys. (C2 fix)
 *
 * Always re-stamps lastActivity to now (this function is only ever called
 * to refresh a cookie in response to a request, i.e. activity).
 *
 * extendExpiry controls whether the refresh also slides the absolute exp
 * forward (near-expiry sliding renewal, existing behavior) or leaves exp
 * untouched (idle-activity-only refresh). Defaulting to true preserves prior
 * behavior for the one pre-existing call site; false is required for
 * idle-only refreshes so they can never extend the 8h absolute cap — that
 * cap must stay a real ceiling, independent of how often lastActivity ticks.
 */
export async function signEmployeeSessionEdge(
  payload: EmployeeSessionPayload,
  options: { extendExpiry?: boolean; durationMs?: number } = {},
): Promise<string> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET missing");
  const extendExpiry = options.extendExpiry ?? true;
  const durationMs = options.durationMs ?? 8 * 60 * 60 * 1000;
  const fullPayload: EmployeeSessionPayload = {
    ...payload,
    exp: extendExpiry ? Date.now() + durationMs : payload.exp,
    lastActivity: Date.now(),
  };
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
