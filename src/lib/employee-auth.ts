// Employee PIN auth — paralelo a NextAuth/Google OAuth (que sigue siendo
// el flujo del dueño). El empleado se loguea con PIN corto y mantiene
// sesión vía cookie firmada HMAC. NO usa NextAuth — flujo independiente.
//
// Por qué no extender NextAuth con credentials: agrega complejidad al
// money path del dueño que ya está en producción. Mejor flujo paralelo
// que no toca el camino del dueño.

import { createHmac, hkdfSync, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/prisma";

const SCRYPT_KEYLEN = 32;
const SCRYPT_COST = 16384; // N parameter — balance entre seguridad y latencia
const PIN_HASH_VERSION = "v1";
const COOKIE_TTL_MS = 8 * 60 * 60 * 1000; // 8h — turno laboral típico

// HKDF domain separation: employee session signing uses a key derived from
// AUTH_SECRET with this label, isolating it from NextAuth JWTs and from
// owner-native tokens (which use "velora-owner-native-v1"). Per Google 2026
// security guidance, secrets must not be reused across distinct trust domains.
const EMPLOYEE_HKDF_INFO = "velora-employee-session-v1";

// RFC 5869 §3.1: zero-length salt collapses the extract phase, weakening
// derivation when IKM has low entropy. A fixed domain salt is the standard
// mitigation — it is NOT secret and does NOT need rotation (it separates
// domains, not sessions). Changing this value invalidates all derived keys
// (forces a one-time re-login). Intentional break on first deploy.
const HKDF_SALT = Buffer.from("velora-hkdf-salt-v1", "utf8");

function deriveEmployeeKey(secret: string): Buffer {
  // hkdfSync(digest, ikm, salt, info, keylen) — Node 18+
  const derived = hkdfSync("sha256", secret, HKDF_SALT, EMPLOYEE_HKDF_INFO, 32);
  return Buffer.from(derived);
}

export interface EmployeeSessionPayload {
  employeeId: string;
  businessId: string;
  role: string;
  exp: number;
  sv: number; // session revocation counter — must match Employee.sessionVersion
}

export class EmployeeAuthError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "EmployeeAuthError";
  }
}

/**
 * Hash a PIN with scrypt + random salt. Output format:
 *   v1$<salt-hex>$<hash-hex>
 *
 * scrypt es deliberadamente lento (N=16384) para resistir brute force.
 * Para PINs de 4-6 dígitos esto es overkill defensivo, pero junto con el
 * rate limit en /api/employees/login es la combinación correcta.
 */
export function hashPin(pin: string): string {
  if (typeof pin !== "string" || pin.length < 4 || pin.length > 12) {
    throw new EmployeeAuthError("PIN debe tener entre 4 y 12 caracteres", "PIN_INVALID");
  }
  const salt = randomBytes(16);
  const derived = scryptSync(pin, salt, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  return `${PIN_HASH_VERSION}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

/**
 * Verify a PIN against a stored hash. Constant-time comparison.
 * Returns false on any parse error (corrupted hash, wrong version, etc.).
 */
export function verifyPin(pin: string, storedHash: string): boolean {
  if (typeof pin !== "string" || typeof storedHash !== "string") return false;
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== PIN_HASH_VERSION) return false;
  let saltBytes: Buffer;
  let expectedBytes: Buffer;
  try {
    saltBytes = Buffer.from(parts[1], "hex");
    expectedBytes = Buffer.from(parts[2], "hex");
  } catch {
    return false;
  }
  if (saltBytes.length === 0 || expectedBytes.length !== SCRYPT_KEYLEN) return false;

  let derivedBytes: Buffer;
  try {
    derivedBytes = scryptSync(pin, saltBytes, SCRYPT_KEYLEN, { N: SCRYPT_COST });
  } catch {
    return false;
  }
  if (derivedBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(derivedBytes, expectedBytes);
}

/**
 * Sign an employee session payload with HMAC. Output format:
 *   <base64url-payload>.<base64url-signature>
 *
 * Reuses AUTH_SECRET (NextAuth secret) for HMAC keying — same trust
 * boundary as OAuth sessions, single env var to manage.
 *
 * @param sessionDurationHours — override the default 8-hour TTL (from
 *   Business.sessionDurationHours). Defaults to 8 if not provided.
 */
export function signEmployeeSession(
  payload: Omit<EmployeeSessionPayload, "exp">,
  sessionDurationHours?: number | null,
): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new EmployeeAuthError("AUTH_SECRET no configurado", "SECRET_MISSING");
  }
  const ttlMs = (sessionDurationHours ?? 8) * 60 * 60 * 1000;
  const fullPayload: EmployeeSessionPayload = {
    ...payload,
    exp: Date.now() + ttlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");
  // Sign with HKDF-derived key (domain-separated from AUTH_SECRET).
  const signingKey = deriveEmployeeKey(secret);
  const signature = createHmac("sha256", signingKey).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

/**
 * Verify and decode an employee session cookie.
 * Returns null on any failure (bad signature, expired, malformed, sv mismatch).
 * Caller should treat null as "not authenticated as employee".
 */
export function verifyEmployeeSession(cookie: string | null | undefined): EmployeeSessionPayload | null {
  if (!cookie || typeof cookie !== "string") return null;
  const secret = process.env.AUTH_SECRET;
  if (!secret) return null;

  const dotIdx = cookie.indexOf(".");
  if (dotIdx <= 0 || dotIdx === cookie.length - 1) return null;
  const payloadB64 = cookie.slice(0, dotIdx);
  const signature = cookie.slice(dotIdx + 1);

  // Verify with HKDF-derived key (domain label + fixed salt per RFC 5869 §3.1).
  // Legacy raw-secret and legacy zero-salt fallbacks removed — C1/C2 fix
  // (2026-05-25) introduced the salt; all pre-existing cookies are intentionally
  // invalidated on first deploy (one-time re-login required).
  const signingKey = deriveEmployeeKey(secret);
  const expected = createHmac("sha256", signingKey).update(payloadB64).digest("base64url");
  const sigBuf = Buffer.from(signature, "base64url");
  const expectedBuf = Buffer.from(expected, "base64url");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  let parsed: EmployeeSessionPayload;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    typeof parsed?.employeeId !== "string" ||
    typeof parsed?.businessId !== "string" ||
    typeof parsed?.role !== "string" ||
    typeof parsed?.exp !== "number" ||
    typeof parsed?.sv !== "number"
  ) {
    return null;
  }
  if (parsed.exp < Date.now()) return null;
  return parsed;
}

// HKDF info label for login token derivation — distinct from the session label
// so login tokens are domain-separated from employee session keys.
// The `?t=` param is NOT server-side validated (anti-phishing URL hint only),
// so changing this derivation is safe: no persisted or long-lived flow depends
// on the old raw-HMAC output.
const LOGIN_TOKEN_HKDF_INFO = "velora-login-token-v1";

/**
 * Derives a short, deterministic 12-character login token for a business.
 * Used to generate the PIN-entry URL for employee onboarding.
 * Includes loginTokenVersion so rotating it (rotateBusinessLoginToken)
 * invalidates all previously issued login URLs.
 *
 * Key derivation uses HKDF with a distinct label — domain-separated from the
 * employee session key (EMPLOYEE_HKDF_INFO). Raw AUTH_SECRET is the IKM;
 * HKDF_SALT and LOGIN_TOKEN_HKDF_INFO ensure the derived key is purpose-bound.
 * Ref: RFC 5869 §3 — HKDF for key material expansion with domain separation.
 */
export function businessLoginToken(businessId: string, loginTokenVersion = 1): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET_MISSING");
  // Derive a purpose-bound key from AUTH_SECRET — mirrors deriveEmployeeKey
  // but with a distinct info label for domain separation.
  const derived = hkdfSync("sha256", secret, HKDF_SALT, LOGIN_TOKEN_HKDF_INFO, 32);
  const key = Buffer.from(derived);
  const input = `${businessId}:${loginTokenVersion}`;
  const full = createHmac("sha256", key).update(input).digest("base64url");
  // base64url alphabet: A-Z a-z 0-9 - _  (URL-safe, no padding)
  return full.slice(0, 12);
}

/**
 * Canonical revocation entry point — bump Employee.sessionVersion,
 * invalidating all existing HMAC cookies for that employee across ALL
 * devices and browser tabs. resolveActor() rejects any cookie whose sv
 * does not match the current DB value and logs EMPLOYEE_SESSION_VERSION_MISMATCH.
 *
 * Call this on: explicit logout, PIN reset, force-logout by owner, role change,
 * or any privilege elevation. Analogous to OWASP session regeneration on
 * privilege change.
 * https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
 */
export async function invalidateEmployeeSessions(employeeId: string): Promise<void> {
  await prisma.employee.update({
    where: { id: employeeId },
    data: { sessionVersion: { increment: 1 } },
  });
}

/**
 * Bump Business.loginTokenVersion, invalidating all previously issued
 * employee login URLs for this business. New URLs must be regenerated.
 */
export async function rotateBusinessLoginToken(businessId: string): Promise<void> {
  await prisma.business.update({
    where: { id: businessId },
    data: { loginTokenVersion: { increment: 1 } },
  });
}

export const EMPLOYEE_COOKIE_NAME = "velora-employee-session";
export const EMPLOYEE_COOKIE_TTL_MS = COOKIE_TTL_MS;
