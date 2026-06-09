// Agent Identity — Ed25519 JWK-based cryptographic identity for Velora agents.
// Each agent has a PEM PKCS#8 keypair in GCP Secret Manager (AGENT_IDENTITY_KEY_*).
// Outbound: sign a 60-second JWT in X-Agent-Assertion.
// Inbound: verify signature + claims + JTI nonce (replay protection via a2a-jti-cache).
// FAIL-CLOSED: absent key at verify time → CRITICAL log + rejected call.
//
// Key cache and secret loading live in agent-identity-key-cache.ts (split for 300-line cap).

import { sign, verify, createPublicKey } from "crypto";
import { cloudLog, type CloudLogSeverity } from "@/lib/cloud-logger";
import { markJtiSeen } from "@/lib/a2a-jti-cache";
import { loadKeyPair } from "@/lib/agent-identity-key-cache";
export { clearKeyPairCache } from "@/lib/agent-identity-key-cache";

// ── Types ─────────────────────────────────────────────────────────────────────

// AgentId enumerates Velora's A2A peer agents. OCA, Correo Argentino and
// Andreani are NOT peers — they are courier providers accessed through
// Logística's internal adapter layer (decisions 2026-05-20).
// "customer" added 2026-05-28 (Step 4): Customer Agent Coordinator handles
// inbound customer interactions delegated from the Supervisor via A2A.
export type AgentId =
  | "supervisor" | "companion" | "payments" | "fiscal"
  | "logistica" | "onboarding" | "ventas" | "equipo" | "communications"
  | "customer" | "caja" | "inventario";

export interface JwkPublicKey {
  kid: string;
  kty: "OKP";
  crv: "Ed25519";
  x: string; // base64url-encoded public key bytes
}

// ── Env var map ───────────────────────────────────────────────────────────────

export const AGENT_KEY_ENV: Record<AgentId, string> = {
  supervisor:     "AGENT_IDENTITY_KEY_SUPERVISOR",
  companion:      "AGENT_IDENTITY_KEY_COMPANION",
  payments:       "AGENT_IDENTITY_KEY_PAYMENTS",
  fiscal:         "AGENT_IDENTITY_KEY_FISCAL",
  logistica:      "AGENT_IDENTITY_KEY_LOGISTICA",
  onboarding:     "AGENT_IDENTITY_KEY_ONBOARDING",
  ventas:         "AGENT_IDENTITY_KEY_VENTAS",
  equipo:         "AGENT_IDENTITY_KEY_EQUIPO",
  // AGENT_IDENTITY_KEY_COMMUNICATIONS is provisioned in Secret Manager and Cloud Run (2026-05-27).
  // The agent is LEAF_ONLY — it receives inbound A2A calls but never initiates outbound ones.
  // signAgentAssertion("communications",...) returns null (LEAF_ONLY_AGENTS guard below).
  communications: "AGENT_IDENTITY_KEY_COMMUNICATIONS",
  // AGENT_IDENTITY_KEY_CUSTOMER added 2026-05-28 (Step 4).
  // Post-deploy provisioning: generate Ed25519 keypair + add to Secret Manager.
  // See docs/REFACTOR_STEP4_CUSTOMER_AGENT.md §Post-Deploy.
  customer:       "AGENT_IDENTITY_KEY_CUSTOMER",
  // AGENT_IDENTITY_KEY_CAJA added 2026-06-03 (Caja Agent).
  // Post-deploy provisioning: generate Ed25519 keypair + add to Secret Manager.
  // Fail-open: missing key logs WARNING and disables agent identity for Caja (same pattern
  // as all other agents). The per-tenant HMAC key gate (X-API-Key) is the primary auth.
  caja:           "AGENT_IDENTITY_KEY_CAJA",
  // AGENT_IDENTITY_KEY_INVENTARIO added 2026-06-03.
  // Post-deploy provisioning: generate Ed25519 keypair + add to Secret Manager.
  // Code fails-open when key is absent (same as all other agents).
  inventario:     "AGENT_IDENTITY_KEY_INVENTARIO",
};

/** Leaf-only agents receive A2A calls but never initiate them. signAgentAssertion returns null. */
export const LEAF_ONLY_AGENTS = new Set<AgentId>(["communications"]);

function kidForAgent(agentId: AgentId): string {
  return `velora-${agentId}-v1`;
}

/** Convenience: load the key pair for an agent using this module's env map. */
function kpFor(agentId: AgentId) {
  return loadKeyPair(agentId, AGENT_KEY_ENV[agentId], kidForAgent(agentId));
}

// ── JWT helpers ───────────────────────────────────────────────────────────────

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function decodeBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

interface JwtPayload {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

function encodeJwt(header: object, payload: object, privateKeyPem: string): string {
  const h = base64url(JSON.stringify(header));
  const p = base64url(JSON.stringify(payload));
  const message = Buffer.from(`${h}.${p}`);
  const sig = sign(null, message, { key: privateKeyPem, format: "pem" } as Parameters<typeof sign>[2]);
  return `${h}.${p}.${base64url(sig)}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sign an outbound A2A assertion JWT for the given agent pair.
 * Returns the signed JWT, or null if the key is not configured.
 */
export function signAgentAssertion(
  issuerAgentId: AgentId,
  audienceAgentId: AgentId | string,
): string | null {
  if (LEAF_ONLY_AGENTS.has(issuerAgentId)) return null; // leaf agents never initiate A2A

  const kp = kpFor(issuerAgentId);
  if (!kp) {
    const isTest = process.env.NODE_ENV === "test";
    cloudLog({
      severity: isTest ? "WARNING" : "ERROR",
      component: "A2A",
      action: "SIGN_KEY_MISSING",
      a2a_transfer: false,
      message: `${AGENT_KEY_ENV[issuerAgentId]} not set — outbound assertion unauthenticated for ${issuerAgentId}`,
      data: { issuerAgentId },
    });
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        `Agent identity key missing for caller=${issuerAgentId}. Set ${AGENT_KEY_ENV[issuerAgentId]} in Secret Manager.`,
      );
    }
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    iss: issuerAgentId,
    sub: issuerAgentId,
    aud: String(audienceAgentId),
    iat: now,
    exp: now + 60,
    jti: crypto.randomUUID(),
  };
  return encodeJwt({ alg: "EdDSA", typ: "JWT", kid: kp.kid }, payload, kp.privateKeyPem);
}

/**
 * Validate an inbound X-Agent-Assertion JWT.
 * Returns true if signature is valid, claims match, and JTI is fresh.
 */
export async function verifyAgentAssertion(
  token: string | null | undefined,
  expectedIss: AgentId,
  expectedAud: AgentId,
): Promise<boolean> {
  if (!token) {
    const issKey = AGENT_KEY_ENV[expectedIss];
    const severity = !process.env[issKey] ? "CRITICAL" : "WARNING";
    const action = !process.env[issKey] ? "ASSERTION_KEY_MISSING" : "ASSERTION_MISSING";
    const message = !process.env[issKey]
      ? `${issKey} not configured — A2A call from ${expectedIss} rejected (fail-closed)`
      : `X-Agent-Assertion missing; ${expectedIss} has a key configured`;
    cloudLog({ severity, component: "A2A", action, a2a_transfer: false, message, data: { expectedIss, expectedAud } });
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "ASSERTION_MALFORMED",
      a2a_transfer: false, message: "JWT does not have 3 parts", data: {} });
    return false;
  }

  let header: { alg?: string };
  let payload: Partial<JwtPayload>;
  try {
    header = JSON.parse(decodeBase64url(parts[0]).toString("utf8")) as { alg?: string };
    payload = JSON.parse(decodeBase64url(parts[1]).toString("utf8")) as Partial<JwtPayload>;
  } catch {
    cloudLog({ severity: "WARNING", component: "A2A", action: "ASSERTION_MALFORMED",
      a2a_transfer: false, message: "JWT header/payload decode failed", data: {} });
    return false;
  }

  if (header.alg !== "EdDSA") {
    cloudLog({ severity: "WARNING", component: "A2A", action: "ASSERTION_WRONG_ALG",
      a2a_transfer: false, message: `JWT alg must be EdDSA, got ${header.alg}`, data: { alg: header.alg } });
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  // Reject at boundary: RFC 7519 §4.1.4 — must not accept ON OR AFTER exp.
  if (payload.exp === undefined || payload.exp <= now) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "ASSERTION_EXPIRED",
      a2a_transfer: false, message: "JWT expired", data: { exp: payload.exp, now } });
    return false;
  }
  if (payload.iss !== expectedIss) {
    // Bug fix: include diagnostic fields so the genuine-failure log has context.
    // See: cloud.google.com/logging/docs/structured-logging (2026).
    cloudLog({ severity: "WARNING", component: "A2A", action: "ASSERTION_WRONG_ISSUER",
      a2a_transfer: false, message: `Expected iss=${expectedIss} got ${payload.iss}`,
      data: { expectedIss, gotIss: payload.iss, expectedAud, gotAud: payload.aud } });
    return false;
  }
  if (payload.aud !== expectedAud) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "ASSERTION_WRONG_AUD",
      a2a_transfer: false, message: `Expected aud=${expectedAud} got ${payload.aud}`, data: {} });
    return false;
  }

  const kp = kpFor(expectedIss);
  if (!kp) {
    cloudLog({ severity: "CRITICAL", component: "A2A", action: "ASSERTION_KEY_MISSING",
      a2a_transfer: false,
      message: `${AGENT_KEY_ENV[expectedIss]} not configured — cannot verify assertion from ${expectedIss} (fail-closed)`,
      data: { expectedIss, expectedAud } });
    return false;
  }

  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: kp.publicKeyBase64url }, format: "jwk",
    });
    const message = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = decodeBase64url(parts[2]);
    if (!verify(null, message, publicKey, sig)) return false;
  } catch (err) {
    cloudLog({ severity: "ERROR", component: "A2A", action: "ASSERTION_VERIFY_ERROR",
      a2a_transfer: false, message: "Signature verification threw",
      data: { error: err instanceof Error ? err.message : String(err), expectedIss, expectedAud, iss: payload.iss } });
    return false;
  }

  if (!payload.jti) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "ASSERTION_MISSING_JTI",
      a2a_transfer: false, message: "JWT missing jti — replay protection unavailable", data: {} });
    return false;
  }
  try {
    await markJtiSeen(payload.jti, payload.exp!);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2002") {
      cloudLog({ severity: "WARNING", component: "A2A", action: "ASSERTION_JTI_REPLAY",
        a2a_transfer: false, message: `JTI replay detected: ${payload.jti}`,
        data: { jti: payload.jti, expectedIss, expectedAud } });
      return false;
    }
    cloudLog({ severity: "ERROR", component: "A2A", action: "ASSERTION_JTI_INSERT_ERROR",
      a2a_transfer: false, message: "JTI nonce insert failed",
      data: { error: err instanceof Error ? err.message : String(err), expectedIss, expectedAud, iss: payload.iss } });
    return false;
  }

  return true;
}


export { verifyAgentAssertionMulti } from "@/lib/agent-identity-multi-verify";

/**
 * Return the JWK public key for a given agent (served from /jwks endpoints).
 * Returns null if the key is not configured.
 */
export function getPublicJwk(agentId: AgentId): JwkPublicKey | null {
  const kp = kpFor(agentId);
  if (!kp) return null;
  return { kid: kp.kid, kty: "OKP", crv: "Ed25519", x: kp.publicKeyBase64url };
}
