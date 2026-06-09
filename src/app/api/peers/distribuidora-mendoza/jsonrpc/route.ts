// Distribuidora Mendoza — JSON-RPC endpoint (POST).
//
// Receives A2A message/send requests from Velora's Supervisor.
// Validates the X-Agent-Assertion header (Supervisor must sign its requests)
// and dispatches to the appropriate skill handler.
//
// In production this endpoint would live on distribuidora-mendoza.com.ar.
// For the Velora demo it coexists in the same Cloud Run instance.
//
// Auth: X-Agent-Assertion JWT signed by the Supervisor (Ed25519 / EdDSA).
// Fail-closed: if AGENT_IDENTITY_KEY_SUPERVISOR is absent or the assertion
// cannot be cryptographically verified, the request is rejected (HTTP 401).

import { createPrivateKey, createPublicKey, verify as cryptoVerify } from "crypto";
import { markJtiSeen } from "@/lib/a2a-jti-cache";
import { NextRequest, NextResponse } from "next/server";
import { dispatchPeerRpc } from "../_lib/handle-peer-rpc";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { signPeerAssertion } from "../_lib/peer-identity";
import { checkRateLimit } from "@/app/api/_lib/route-helpers";

// ── Auth helpers ──────────────────────────────────────────────────────────────

function decodeBase64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from((s + pad).replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * Verify the inbound X-Agent-Assertion from Velora's Supervisor.
 *
 * Fail-closed: any verification failure (missing token, missing key, wrong alg,
 * expired, wrong issuer, bad signature) returns false and the caller rejects
 * the request with HTTP 401. AGENT_IDENTITY_KEY_SUPERVISOR must be present;
 * a missing key is a misconfiguration, not a graceful-pass condition.
 *
 * SEC-N-4: includes JTI replay protection — markJtiSeen() inserts the jti
 * into A2aJtiSeen. A P2002 unique violation means the token was already
 * accepted within its 60-second window → replay attack → reject.
 */
async function verifyInboundSupervisorAssertion(token: string | null | undefined): Promise<boolean> {
  const supervisorPem = process.env.AGENT_IDENTITY_KEY_SUPERVISOR;

  if (!token) {
    const severity = !supervisorPem ? "CRITICAL" : "WARNING";
    const action = !supervisorPem ? "PEER_INBOUND_ASSERTION_MISSING_NO_KEY" : "PEER_INBOUND_ASSERTION_MISSING";
    const message = !supervisorPem
      ? "X-Agent-Assertion absent and AGENT_IDENTITY_KEY_SUPERVISOR not set — fail-closed"
      : "X-Agent-Assertion header missing from inbound peer call";
    cloudLog({ severity, component: "A2A", action, a2a_transfer: true, message, data: {} });
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "PEER_INBOUND_ASSERTION_MALFORMED",
      a2a_transfer: true, message: "JWT does not have 3 parts", data: {} });
    return false;
  }

  let header: { alg?: string };
  let payload: Partial<{ iss: string; aud: string; exp: number; jti: string }>;
  try {
    header = JSON.parse(decodeBase64url(parts[0]).toString("utf8")) as { alg?: string };
    payload = JSON.parse(decodeBase64url(parts[1]).toString("utf8")) as typeof payload;
  } catch {
    cloudLog({ severity: "WARNING", component: "A2A", action: "PEER_INBOUND_ASSERTION_DECODE_ERROR",
      a2a_transfer: true, message: "JWT header/payload decode failed", data: {} });
    return false;
  }

  // Pin algorithm — reject anything other than EdDSA to prevent algorithm confusion attacks.
  if (header.alg !== "EdDSA") {
    cloudLog({ severity: "WARNING", component: "A2A", action: "PEER_INBOUND_ASSERTION_WRONG_ALG",
      a2a_transfer: true, message: `JWT alg must be EdDSA, got ${header.alg}`, data: { alg: header.alg } });
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp === undefined || payload.exp < now) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "PEER_INBOUND_ASSERTION_EXPIRED",
      a2a_transfer: true, message: "JWT expired", data: { exp: payload.exp, now } });
    return false;
  }

  if (payload.iss !== "supervisor") {
    cloudLog({ severity: "WARNING", component: "A2A", action: "PEER_INBOUND_ASSERTION_WRONG_ISS",
      a2a_transfer: true, message: `Expected iss=supervisor, got ${payload.iss}`, data: {} });
    return false;
  }

  if (!supervisorPem) {
    // Key absent — cannot verify signature. Fail-closed.
    cloudLog({
      severity: "CRITICAL", component: "A2A", action: "PEER_INBOUND_ASSERTION_NO_KEY",
      a2a_transfer: true,
      message: "AGENT_IDENTITY_KEY_SUPERVISOR not set — cannot verify assertion, fail-closed",
      data: {},
    });
    return false;
  }

  let sigValid: boolean;
  try {
    const privateKey = createPrivateKey({ key: supervisorPem, format: "pem" });
    const publicKey = createPublicKey(privateKey);
    const message = Buffer.from(`${parts[0]}.${parts[1]}`);
    const sig = decodeBase64url(parts[2]);
    sigValid = cryptoVerify(null, message, publicKey, sig);
  } catch (err) {
    cloudLog({ severity: "ERROR", component: "A2A", action: "PEER_INBOUND_ASSERTION_VERIFY_ERROR",
      a2a_transfer: true, message: "Signature verification threw",
      data: { error: err instanceof Error ? err.message : String(err) } });
    return false;
  }

  if (!sigValid) return false;

  // SEC-N-4: JTI replay protection — mirror agent-identity.ts:203-222 pattern.
  // Require jti; reject missing jti (fail-closed) to prevent replay of unsigned tokens.
  if (!payload.jti) {
    cloudLog({ severity: "WARNING", component: "A2A", action: "PEER_INBOUND_ASSERTION_MISSING_JTI",
      a2a_transfer: true, message: "JWT missing jti — replay protection unavailable, rejecting", data: {} });
    return false;
  }
  try {
    await markJtiSeen(payload.jti, payload.exp!);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "P2002") {
      cloudLog({ severity: "WARNING", component: "A2A", action: "PEER_INBOUND_ASSERTION_JTI_REPLAY",
        a2a_transfer: true, message: `JTI replay detected: ${payload.jti}`, data: { jti: payload.jti } });
      return false;
    }
    cloudLog({ severity: "ERROR", component: "A2A", action: "PEER_INBOUND_ASSERTION_JTI_ERROR",
      a2a_transfer: true, message: "JTI nonce insert failed",
      data: { error: err instanceof Error ? err.message : String(err) } });
    return false;
  }

  return true;
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const rateLimited = checkRateLimit(req, "peer-distribuidora-mendoza");
  if (rateLimited) return rateLimited;

  const assertion = req.headers.get("x-agent-assertion");
  if (!await verifyInboundSupervisorAssertion(assertion)) {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Unauthorized: invalid or missing X-Agent-Assertion" } },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 400 },
    );
  }

  cloudLog({
    severity: "INFO",
    component: "A2A",
    action: "PEER_RPC_RECEIVED",
    a2a_transfer: true,
    message: "Distribuidora Mendoza received JSON-RPC call",
    data: { method: (body as { method?: string }).method },
  });

  const result = dispatchPeerRpc(body);

  // Sign the response with our own Agent Identity so the caller can verify us.
  const responseAssertion = signPeerAssertion();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (responseAssertion) {
    headers["X-Agent-Assertion"] = responseAssertion;
  }

  return NextResponse.json(result, { headers });
}
