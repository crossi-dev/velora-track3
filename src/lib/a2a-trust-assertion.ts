// A2A inbound assertion verification — Ed25519 JWT verification against a
// peer's JWKS endpoint. Split out of a2a-trust.ts to keep each module under
// the size limit; the trust CRUD stays in a2a-trust.ts.
//
// verifyAgentAssertion fetches the peer's JWKS endpoint, extracts the public
// key matching `kid`, and verifies the JWT signature. Fail-closed: any error
// → returns false (unknown keys are not trusted).

import { cloudLog } from "@/lib/cloud-logger";
import { createPublicKey, verify } from "crypto";

// SSRF prevention: allowlist of hostnames from which Velora will fetch peer JWKS.
// Peer onboarding: add the new hostname here + record the AgentCard URL in a2a-trust.ts.
// Any jwksUrl whose hostname is NOT in this set is rejected before the network call (fail-closed).
// See OPS-RUNBOOK.md for the full peer onboarding checklist + key rotation procedures.
const JWKS_ALLOWED_HOSTNAMES = new Set([
  "somosvelora.com",
  "api.mercadopago.com",
]);

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtPayload {
  iss?: string;
  sub?: string;
  aud?: string;
  iat?: number;
  exp?: number;
}

function decodeBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verify an inbound X-Agent-Assertion JWT from an external peer.
 *
 * Fetches the peer's JWKS endpoint (from the AgentCard) to obtain the public
 * key, then verifies the EdDSA signature. Returns true only when the signature
 * is valid, the issuer matches, and the JWT is not expired.
 *
 * Fail-closed: any error → returns false.
 *
 * @param token                Raw JWT string from X-Agent-Assertion header.
 * @param expectedIssuerDomain Domain that should have signed the assertion.
 * @param jwksUrl              JWKS endpoint URL from the peer's AgentCard.
 */
export async function verifyAgentAssertion(
  token: string | null | undefined,
  expectedIssuerDomain: string,
  jwksUrl: string,
): Promise<boolean> {
  if (!token) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_ASSERTION_MISSING",
      a2a_transfer: false,
      message: "X-Agent-Assertion header absent from peer response",
      data: { expectedIssuerDomain },
    });
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_ASSERTION_MALFORMED",
      a2a_transfer: false,
      message: "JWT does not have 3 parts",
      data: { expectedIssuerDomain },
    });
    return false;
  }

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = JSON.parse(decodeBase64url(parts[0]).toString("utf8")) as JwtHeader;
    payload = JSON.parse(decodeBase64url(parts[1]).toString("utf8")) as JwtPayload;
  } catch {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_ASSERTION_DECODE_ERROR",
      a2a_transfer: false,
      message: "JWT header/payload decode failed",
      data: { expectedIssuerDomain },
    });
    return false;
  }

  // Pin algorithm — reject anything other than EdDSA to prevent algorithm confusion attacks.
  if (header.alg !== "EdDSA") {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_ASSERTION_WRONG_ALG",
      a2a_transfer: false,
      message: `Peer JWT alg must be EdDSA, got ${header.alg}`,
      data: { expectedIssuerDomain, alg: header.alg },
    });
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || payload.exp < now) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_ASSERTION_EXPIRED",
      a2a_transfer: false,
      message: "Peer JWT expired",
      data: { expectedIssuerDomain, exp: payload.exp, now },
    });
    return false;
  }

  // Validate issuer claim — must match the domain we expect. Without this
  // check a valid JWT from peer A could be replayed to impersonate peer B
  // as long as both share the same JWKS URL.
  if (!payload.iss || payload.iss !== expectedIssuerDomain) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_ASSERTION_WRONG_ISSUER",
      a2a_transfer: false,
      message: `Peer JWT iss mismatch: expected "${expectedIssuerDomain}", got "${payload.iss}"`,
      data: { expectedIssuerDomain, iss: payload.iss },
    });
    return false;
  }

  // SSRF guard: reject jwksUrl whose hostname is not in the known-peer allowlist.
  let jwksHostname: string;
  try {
    jwksHostname = new URL(jwksUrl).hostname;
  } catch {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_JWKS_URL_INVALID",
      a2a_transfer: false,
      message: "jwksUrl is not a valid URL — rejected before fetch",
      data: { expectedIssuerDomain, jwksUrl },
    });
    return false;
  }
  if (!JWKS_ALLOWED_HOSTNAMES.has(jwksHostname)) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_JWKS_URL_NOT_ALLOWLISTED",
      a2a_transfer: false,
      message: `jwksUrl hostname "${jwksHostname}" is not in JWKS_ALLOWED_HOSTNAMES — SSRF rejected`,
      data: { expectedIssuerDomain, jwksUrl, jwksHostname },
    });
    return false;
  }

  // Fetch JWKS from peer
  let jwks: { keys?: Array<{ kid?: string; kty?: string; crv?: string; x?: string }> };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(jwksUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`JWKS returned HTTP ${res.status}`);
    jwks = (await res.json()) as typeof jwks;
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_JWKS_FETCH_FAILED",
      a2a_transfer: false,
      message: "Failed to fetch peer JWKS",
      data: { expectedIssuerDomain, jwksUrl, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }

  // Find matching key — `kid` is required; a JWT with no kid is rejected so
  // that a token signed by key A cannot be accepted under key B just because
  // kid is absent and we default to the first key in the JWKS.
  const kid = header.kid;
  if (!kid) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_ASSERTION_NO_KID",
      a2a_transfer: false,
      message: "JWT header missing kid — cannot select JWKS key safely",
      data: { expectedIssuerDomain },
    });
    return false;
  }
  const matchingKey = (jwks.keys ?? []).find((k) => k.kid === kid);
  if (!matchingKey || matchingKey.kty !== "OKP" || matchingKey.crv !== "Ed25519" || !matchingKey.x) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_JWKS_KEY_NOT_FOUND",
      a2a_transfer: false,
      message: "No matching Ed25519 key in peer JWKS",
      data: { expectedIssuerDomain, kid },
    });
    return false;
  }

  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: matchingKey.x },
      format: "jwk",
    });
    const message = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = decodeBase64url(parts[2]);
    const valid = verify(null, message, publicKey, sig);
    if (!valid) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "PEER_ASSERTION_SIG_INVALID",
        a2a_transfer: false,
        message: "Peer JWT signature verification failed",
        data: { expectedIssuerDomain },
      });
    }
    return valid;
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "PEER_ASSERTION_VERIFY_ERROR",
      a2a_transfer: false,
      message: "Peer JWT signature verification threw",
      data: { expectedIssuerDomain, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}
