// A2A v0.3.0 Agent Card Signing — JWS Compact Serialization (EdDSA / Ed25519).
// Spec: https://a2a-protocol.org/latest/specification/ (validated 2026-05-25)
//
// A2A v0.3.0 requires agent cards to be cryptographically signed to prevent
// MITM spoofing. Cards are signed as JWS Compact (header.payload.signature)
// where payload is the canonicalized card JSON.
//
// Backward compat: clients that ignore the `signature` field continue
// working unchanged. v0.3.0 clients MUST validate the signature before trusting.
//
// signAgentCard(card, agentId)   → adds `signature` field (JWS Compact)
// verifyAgentCardSignature(card) → boolean (fetches peer JWKS to verify)

import { createPrivateKey, createPublicKey, sign, verify } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";
import { type AgentId, getPublicJwk } from "@/lib/agent-identity";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Agent card with an optional v0.3.0 JWS Compact `signature` field. */
export interface SignedAgentCard {
  [key: string]: unknown;
  signature?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function decodeBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Canonicalize a card object before signing.
 *
 * Per A2A v0.3.0 §8.4.1: sort keys deterministically and strip the `signature`
 * field itself before signing (so re-verification always works on the same
 * payload regardless of field order in transit).
 */
function canonicalize(card: SignedAgentCard): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature: _sig, ...rest } = card;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

// ── Private key loader (reads same env vars as agent-identity) ─────────────────

const AGENT_KEY_ENV: Record<AgentId, string> = {
  supervisor:   "AGENT_IDENTITY_KEY_SUPERVISOR",
  companion:    "AGENT_IDENTITY_KEY_COMPANION",
  payments:     "AGENT_IDENTITY_KEY_PAYMENTS",
  fiscal:       "AGENT_IDENTITY_KEY_FISCAL",
  logistica:    "AGENT_IDENTITY_KEY_LOGISTICA",
  // OnboardingAgent — secret not provisioned yet. signAgentCard handles the
  // missing-key case gracefully (warn + skip signature). Set
  // AGENT_IDENTITY_KEY_ONBOARDING in Secret Manager + Cloud Run before any
  // external peer is expected to verify the signed card.
  onboarding:   "AGENT_IDENTITY_KEY_ONBOARDING",
  // Ventas Agent — same provisioning gap; key gets minted in Commit 4 of the
  // Fase B strangler.
  ventas:       "AGENT_IDENTITY_KEY_VENTAS",
  // Communications Agent — same provisioning gap; key minted when ready.
  communications: "AGENT_IDENTITY_KEY_COMMUNICATIONS",
  // Customer Agent — key provisioned post-deploy (Step 4, 2026-05-28).
  customer:       "AGENT_IDENTITY_KEY_CUSTOMER",
  // Caja Agent — key provisioned post-deploy (2026-06-03). Same fail-open pattern.
  caja:           "AGENT_IDENTITY_KEY_CAJA",
  // Inventario Agent — key provisioned post-deploy (2026-06-03). Fail-open until set.
  inventario:     "AGENT_IDENTITY_KEY_INVENTARIO",
};

function loadPrivateKeyPem(agentId: AgentId): string | null {
  const envVar = AGENT_KEY_ENV[agentId];
  return process.env[envVar] ?? null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sign an agent card payload with the agent's Ed25519 private key.
 *
 * Returns the card object with a `signature` field containing a JWS Compact
 * string (header.payload.signature). The payload inside the JWS is the
 * canonicalized card JSON without the `signature` field itself.
 *
 * Returns the card unsigned (no `signature` field) when the key is not
 * configured — transitional: v0.3 clients keep working, a WARNING is logged.
 */
export function signAgentCard(card: SignedAgentCard, agentId: AgentId): SignedAgentCard {
  const pem = loadPrivateKeyPem(agentId);
  if (!pem) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "CARD_SIGN_KEY_MISSING",
      a2a_transfer: false,
      message: `${AGENT_KEY_ENV[agentId]} not set — agent card unsigned for ${agentId}`,
      data: { agentId },
    });
    return card;
  }

  const jwk = getPublicJwk(agentId);
  const kid = jwk?.kid ?? `velora-${agentId}-v1`;

  try {
    const privateKey = createPrivateKey({ key: pem, format: "pem" });
    const canonical = canonicalize(card);
    const headerJson = JSON.stringify({ alg: "EdDSA", typ: "JWT", kid });
    const h = base64url(headerJson);
    const p = base64url(canonical);
    const message = Buffer.from(`${h}.${p}`);
    const sigBuf = sign(null, message, privateKey);
    const jws = `${h}.${p}.${base64url(sigBuf)}`;
    return { ...card, signature: jws };
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "CARD_SIGN_ERROR",
      a2a_transfer: false,
      message: `Failed to sign agent card for ${agentId}`,
      data: { agentId, error: err instanceof Error ? err.message : String(err) },
    });
    return card;
  }
}

/**
 * Verify a signed agent card received from an external peer.
 *
 * Fetches the JWKS endpoint declared in `x-agentIdentity.jwksUrl`, locates
 * the key matching the `kid` in the JWS header, and verifies the EdDSA
 * signature against the canonicalized payload.
 *
 * Returns false (and logs a WARNING) when:
 *  - `signature` field is absent (transitional — log only, caller decides)
 *  - JWS format is invalid
 *  - JWKS fetch fails
 *  - Key not found or wrong algorithm
 *  - Signature verification fails
 *
 * Fail-closed: any error → false.
 */
export async function verifyAgentCardSignature(card: SignedAgentCard): Promise<boolean> {
  const { signature } = card;

  if (!signature) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "CARD_SIG_ABSENT",
      a2a_transfer: false,
      message: "Peer agent card has no signature field — transitional: treating as unverified",
      data: {},
    });
    return false;
  }

  const parts = signature.split(".");
  if (parts.length !== 3) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "CARD_SIG_MALFORMED",
      a2a_transfer: false,
      message: "Card signature is not a valid JWS Compact (expected 3 parts)",
      data: {},
    });
    return false;
  }

  let header: { alg?: string; kid?: string };
  try {
    header = JSON.parse(decodeBase64url(parts[0]).toString("utf8")) as { alg?: string; kid?: string };
  } catch {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "CARD_SIG_DECODE_ERROR",
      a2a_transfer: false,
      message: "Failed to decode JWS header",
      data: {},
    });
    return false;
  }

  if (header.alg !== "EdDSA") {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "CARD_SIG_WRONG_ALG",
      a2a_transfer: false,
      message: `Card signature alg must be EdDSA, got ${header.alg}`,
      data: { alg: header.alg },
    });
    return false;
  }

  if (!header.kid) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "CARD_SIG_NO_KID",
      a2a_transfer: false,
      message: "JWS header missing kid — cannot select JWKS key safely",
      data: {},
    });
    return false;
  }

  // Resolve JWKS URL from the card's x-agentIdentity extension.
  const identity = card["x-agentIdentity"] as { jwksUrl?: string } | undefined;
  const jwksUrl = identity?.jwksUrl;
  if (!jwksUrl) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "CARD_SIG_NO_JWKS_URL",
      a2a_transfer: false,
      message: "Card has no x-agentIdentity.jwksUrl — cannot verify signature",
      data: {},
    });
    return false;
  }

  // Fetch JWKS from peer (5-second timeout).
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
      action: "CARD_JWKS_FETCH_FAILED",
      a2a_transfer: false,
      message: "Failed to fetch peer JWKS for card verification",
      data: { jwksUrl, error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }

  const kid = header.kid;
  const matchingKey = (jwks.keys ?? []).find((k) => k.kid === kid);
  if (!matchingKey || matchingKey.kty !== "OKP" || matchingKey.crv !== "Ed25519" || !matchingKey.x) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "CARD_JWKS_KEY_NOT_FOUND",
      a2a_transfer: false,
      message: "No matching Ed25519 key in peer JWKS for card verification",
      data: { kid },
    });
    return false;
  }

  // Reconstruct the expected signed message: header.canonicalized-card
  const canonical = canonicalize(card);
  const expectedH = parts[0];
  const expectedP = base64url(canonical);
  const message = Buffer.from(`${expectedH}.${expectedP}`);
  const sig = decodeBase64url(parts[2]);

  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: matchingKey.x },
      format: "jwk",
    });
    const valid = verify(null, message, publicKey, sig);
    if (!valid) {
      cloudLog({
        severity: "WARNING",
        component: "A2A",
        action: "CARD_SIG_INVALID",
        a2a_transfer: false,
        message: "Agent card signature verification failed",
        data: { kid, jwksUrl },
      });
    }
    return valid;
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "CARD_SIG_VERIFY_ERROR",
      a2a_transfer: false,
      message: "Agent card signature verification threw",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return false;
  }
}
