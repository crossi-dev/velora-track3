// Edge-compatible owner native-token verification.
//
// Mirrors the pattern from employee-auth-edge.ts exactly.
// Used by middleware (Edge Runtime) and route handlers.
//
// Node crypto is NOT available in Edge Runtime — all signing and verification
// is done with Web Crypto (crypto.subtle), which is available in both Edge
// and Node runtimes.

export const OWNER_NATIVE_HEADER = "x-velora-owner-token";
export const OWNER_NATIVE_REFRESH_HEADER = "x-velora-owner-token-refresh";
export const OWNER_NATIVE_REFRESH_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6h — triggers proactive refresh
export const OWNER_NATIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24h (was 7 days; reduced C2)

// HKDF domain label — keeps native-token signing isolated from AUTH_SECRET's
// other uses (NextAuth sessions, etc.). Changing this string invalidates all
// existing tokens (forces re-login once). Intentional for pre-demo deploy. (C3)
const HKDF_INFO = "velora-owner-native-v1";

export interface OwnerNativeSessionPayload {
  userId: string;
  email: string;
  exp: number;
  iat: number; // M1: required by RFC 7519 §4.1.6; enables server-side replay window
}

export interface VerifiedOwnerNativeSession {
  payload: OwnerNativeSessionPayload;
  shouldRefresh: boolean;
}

// RFC 5869 §3.1: fixed domain salt prevents extract-phase collapse when IKM
// has limited entropy. NOT secret, NOT rotated — its purpose is domain
// separation, not session uniqueness. Changing this value invalidates all
// derived keys (one-time re-login). Intentional break on first deploy. (C1)
const HKDF_SALT = new TextEncoder().encode("velora-hkdf-salt-v1");

/**
 * Derive the HMAC signing key from AUTH_SECRET using HKDF with a domain label
 * and fixed domain salt (C1 — RFC 5869 §3.1 compliance).
 * This isolates native-token signing from NextAuth session signing (C3).
 * Both Edge and Node 20+ support crypto.subtle.deriveKey with HKDF.
 */
async function deriveHmacKey(usage: "sign" | "verify"): Promise<CryptoKey> {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET missing");
  const encoder = new TextEncoder();
  const ikm = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: encoder.encode(HKDF_INFO) },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    [usage],
  );
}

/**
 * Verify an owner native token using Web Crypto. Returns null on any error
 * (invalid signature, corrupted payload, expired, missing AUTH_SECRET).
 *
 * shouldRefresh = true when valid but expiring within
 * OWNER_NATIVE_REFRESH_THRESHOLD_MS — signals callers to issue a refreshed token.
 */
export async function verifyOwnerNativeToken(
  token: string | null | undefined,
): Promise<VerifiedOwnerNativeSession | null> {
  if (!token || typeof token !== "string") return null;
  if (!process.env.AUTH_SECRET) return null;

  const dotIdx = token.indexOf(".");
  if (dotIdx <= 0 || dotIdx === token.length - 1) return null;
  const payloadB64 = token.slice(0, dotIdx);
  const signatureB64 = token.slice(dotIdx + 1);

  let expected: string;
  try {
    const encoder = new TextEncoder();
    const key = await deriveHmacKey("sign");
    const sigBuf = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
    expected = base64UrlEncode(new Uint8Array(sigBuf));
  } catch {
    return null;
  }

  if (!constantTimeEqual(signatureB64, expected)) return null;

  let parsed: OwnerNativeSessionPayload;
  try {
    parsed = JSON.parse(base64UrlDecodeUtf8(payloadB64)) as OwnerNativeSessionPayload;
  } catch {
    return null;
  }

  if (
    typeof parsed?.userId !== "string" ||
    typeof parsed?.email !== "string" ||
    typeof parsed?.exp !== "number"
  ) {
    return null;
  }
  if (parsed.exp < Date.now()) return null;

  // M1: reject tokens with iat in the future (60s skew allowed).
  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof parsed.iat === "number" && parsed.iat > nowSec + 60) return null;

  const shouldRefresh =
    parsed.exp - Date.now() < OWNER_NATIVE_REFRESH_THRESHOLD_MS;
  return { payload: parsed, shouldRefresh };
}

/**
 * Sign an owner native token payload using Web Crypto (Edge-compatible).
 * Used by the native-session endpoint and middleware refresh path.
 * Key is derived via HKDF from AUTH_SECRET (C3 domain separation).
 * Adds iat claim (M1).
 */
export async function signOwnerNativeTokenEdge(
  payload: Omit<OwnerNativeSessionPayload, "exp" | "iat">,
  durationMs = OWNER_NATIVE_TTL_MS,
): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const fullPayload: OwnerNativeSessionPayload = {
    ...payload,
    iat: nowSec,
    exp: Date.now() + durationMs,
  };
  const encoder = new TextEncoder();
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const key = await deriveHmacKey("sign");
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
