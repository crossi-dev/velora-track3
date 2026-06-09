// agent-identity-multi-verify.ts — Multi-candidate A2A assertion verification.
//
// Extracted from agent-identity.ts to stay under the 300-line [server/lib] limit.
//
// verifyAgentAssertionMulti implements collect-then-decide:
//   iterate candidates silently, emit ONE consolidated WARNING only when all fail.
// Pattern: Google IAM multi-candidate token verification (2026).

import { cloudLog, type CloudLogSeverity } from "@/lib/cloud-logger";
import { createPublicKey, verify } from "crypto";
import { markJtiSeen } from "@/lib/a2a-jti-cache";
import { AGENT_KEY_ENV, type AgentId } from "@/lib/agent-identity";

// Re-export the private helpers we need — pulled in as named imports from agent-identity
// to avoid circular deps: agent-identity exports types/constants only, this file
// contains the multi-issuer verification logic.

// Internal JwtPayload shape (mirrors agent-identity.ts — kept local to avoid
// exporting an internal type from the main module).
interface JwtPayload {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

function decodeBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

import { loadKeyPair } from "@/lib/agent-identity-key-cache";

function kidForAgent(agentId: AgentId): string {
  return `velora-${agentId}-v1`;
}

function kpFor(agentId: AgentId) {
  return loadKeyPair(agentId, AGENT_KEY_ENV[agentId], kidForAgent(agentId));
}

// -- Verification result type (for multi-candidate collect-then-decide) ----
//
// Pattern: iterate candidates silently, log only when ALL fail.
// Canonical reference: Google IAM multi-candidate token verification.
// See: cloud.google.com/iam/docs/reference/credentials/rest (2026).
type AssertionResult =
  | { ok: true }
  | { ok: false; action: string; message: string; data: Record<string, unknown> };

/**
 * Single-candidate verify with optional silent mode.
 * When silent=true, suppresses logging and returns typed rejection reason.
 * Used by verifyAgentAssertionMulti to iterate candidates without emitting noise.
 */
async function verifyAgentAssertionOnce(
  token: string | null | undefined,
  expectedIss: AgentId,
  expectedAud: AgentId,
  silent: boolean,
): Promise<AssertionResult> {
  const emit = (
    severity: CloudLogSeverity,
    action: string,
    message: string,
    data: Record<string, unknown>,
  ): AssertionResult => {
    if (!silent) cloudLog({ severity, component: "A2A", action, a2a_transfer: false, message, data });
    return { ok: false, action, message, data };
  };

  if (!token) {
    const issKey = AGENT_KEY_ENV[expectedIss];
    const severity: CloudLogSeverity = !process.env[issKey] ? "CRITICAL" : "WARNING";
    const action = !process.env[issKey] ? "ASSERTION_KEY_MISSING" : "ASSERTION_MISSING";
    const message = !process.env[issKey]
      ? `${issKey} not configured -- A2A call from ${expectedIss} rejected (fail-closed)`
      : `X-Agent-Assertion missing; ${expectedIss} has a key configured`;
    return emit(severity, action, message, { expectedIss, expectedAud });
  }

  const parts = token.split(".");
  if (parts.length !== 3) return emit("WARNING", "ASSERTION_MALFORMED", "JWT does not have 3 parts", {});

  let header: { alg?: string };
  let payload: Partial<JwtPayload>;
  try {
    header = JSON.parse(decodeBase64url(parts[0]).toString("utf8")) as { alg?: string };
    payload = JSON.parse(decodeBase64url(parts[1]).toString("utf8")) as Partial<JwtPayload>;
  } catch {
    return emit("WARNING", "ASSERTION_MALFORMED", "JWT header/payload decode failed", {});
  }

  if (header.alg !== "EdDSA") {
    return emit("WARNING", "ASSERTION_WRONG_ALG",
      `JWT alg must be EdDSA, got ${header.alg}`, { alg: header.alg });
  }

  const now = Math.floor(Date.now() / 1000);
  // RFC 7519 §4.1.4: MUST NOT accept ON OR AFTER exp (same boundary as single-verify).
  if (payload.exp === undefined || payload.exp <= now) {
    return emit("WARNING", "ASSERTION_EXPIRED", "JWT expired", { exp: payload.exp, now });
  }
  if (payload.iss !== expectedIss) {
    // Bug fix 2: include diagnostic fields so the genuine-failure log has context.
    // See: cloud.google.com/logging/docs/structured-logging (2026).
    return emit("WARNING", "ASSERTION_WRONG_ISSUER",
      `Expected iss=${expectedIss} got ${payload.iss}`,
      { expectedIss, gotIss: payload.iss, expectedAud, gotAud: payload.aud });
  }
  if (payload.aud !== expectedAud) {
    return emit("WARNING", "ASSERTION_WRONG_AUD",
      `Expected aud=${expectedAud} got ${payload.aud}`,
      { expectedIss, gotIss: payload.iss, expectedAud, gotAud: payload.aud });
  }

  const kp = kpFor(expectedIss);
  if (!kp) {
    return emit("CRITICAL", "ASSERTION_KEY_MISSING",
      `${AGENT_KEY_ENV[expectedIss]} not configured -- cannot verify assertion from ${expectedIss} (fail-closed)`,
      { expectedIss, expectedAud });
  }

  try {
    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: kp.publicKeyBase64url }, format: "jwk",
    });
    const message = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = decodeBase64url(parts[2]);
    if (!verify(null, message, publicKey, sig)) {
      return emit("WARNING", "ASSERTION_SIG_INVALID", "Signature verification failed", { expectedIss, expectedAud });
    }
  } catch (err) {
    return emit("ERROR", "ASSERTION_VERIFY_ERROR", "Signature verification threw",
      { error: err instanceof Error ? err.message : String(err) });
  }

  if (!payload.jti) {
    return emit("WARNING", "ASSERTION_MISSING_JTI", "JWT missing jti -- replay protection unavailable", {});
  }
  try {
    await markJtiSeen(payload.jti, payload.exp!);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2002") {
      if (!silent) cloudLog({ severity: "WARNING", component: "A2A", action: "ASSERTION_JTI_REPLAY",
        a2a_transfer: false, message: `JTI replay detected: ${payload.jti}`,
        data: { jti: payload.jti, expectedIss, expectedAud } });
      return { ok: false, action: "ASSERTION_JTI_REPLAY",
        message: `JTI replay detected: ${payload.jti}`,
        data: { jti: payload.jti, expectedIss, expectedAud } };
    }
    if (!silent) cloudLog({ severity: "ERROR", component: "A2A", action: "ASSERTION_JTI_INSERT_ERROR",
      a2a_transfer: false, message: "JTI nonce insert failed",
      data: { error: err instanceof Error ? err.message : String(err) } });
    return { ok: false, action: "ASSERTION_JTI_INSERT_ERROR", message: "JTI nonce insert failed",
      data: { error: err instanceof Error ? err.message : String(err) } };
  }
  return { ok: true };
}

/**
 * Validate an inbound X-Agent-Assertion JWT against multiple candidate issuers.
 *
 * Implements collect-then-decide: each candidate is tried in silent mode.
 * On first success the call is accepted and no log is emitted.
 * Only when ALL candidates fail does this emit a single consolidated WARNING --
 * eliminating spurious ASSERTION_WRONG_ISSUER noise from legitimate cross-issuer
 * calls (e.g. Supervisor->Logistica which also accepts Payments).
 *
 * Pattern: collect-then-decide multi-candidate verification (IAM canonical).
 * Reference: cloud.google.com/iam/docs/reference/credentials/rest (2026).
 */
export async function verifyAgentAssertionMulti(
  token: string | null | undefined,
  candidates: AgentId[],
  expectedAud: AgentId,
): Promise<boolean> {
  const rejections: AssertionResult[] = [];
  for (const iss of candidates) {
    const result = await verifyAgentAssertionOnce(token, iss, expectedAud, true);
    if (result.ok) return true;
    rejections.push(result);
  }
  cloudLog({
    severity: "WARNING",
    component: "A2A",
    action: "ASSERTION_ALL_ISSUERS_FAILED",
    a2a_transfer: false,
    message: `X-Agent-Assertion rejected by all ${candidates.length} candidate issuer(s) for aud=${expectedAud}`,
    data: {
      candidates,
      expectedAud,
      rejections: rejections.map((r) => r.ok ? null : { action: r.action, message: r.message, ...r.data }),
    },
  });
  return false;
}
