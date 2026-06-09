// Distribuidora Mendoza — peer Agent Identity signing.
//
// Signs outbound JSON-RPC responses so Velora's Supervisor can verify
// that replies come from the legitimate Distribuidora Mendoza agent.
//
// Key loaded from AGENT_IDENTITY_KEY_DISTRIBUIDORA_MENDOZA (PEM PKCS#8).
// Graceful degradation: if key absent → returns null (no header sent).

import { createPrivateKey, sign, randomUUID } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";

const AGENT_ID = "distribuidora-mendoza";
const KID = "distribuidora-mendoza-v1";

function base64url(buf: Buffer | string): string {
  const b = typeof buf === "string" ? Buffer.from(buf) : buf;
  return b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Sign a short-lived JWT assertion from Distribuidora Mendoza.
 * Returns the JWT string or null if the key is not configured.
 */
export function signPeerAssertion(): string | null {
  const pem = process.env.AGENT_IDENTITY_KEY_DISTRIBUIDORA_MENDOZA;
  if (!pem) return null;

  try {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "EdDSA", typ: "JWT", kid: KID };
    const payload = {
      iss: AGENT_ID,
      sub: AGENT_ID,
      aud: "velora-supervisor",
      iat: now,
      exp: now + 60,
      // SEC-N-5: jti required for replay protection — if/when verifyAgentAssertion
      // is hardened to reject missing jti (SEC-N-3 fix), outbound responses
      // must carry a unique token ID or they will be rejected as replays.
      jti: randomUUID(),
    };

    const h = base64url(JSON.stringify(header));
    const p = base64url(JSON.stringify(payload));
    const message = Buffer.from(`${h}.${p}`);
    const privateKey = createPrivateKey({ key: pem, format: "pem" });
    const sig = sign(null, message, { key: privateKey } as Parameters<typeof sign>[2]);
    return `${h}.${p}.${base64url(sig)}`;
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_SIGN_ERROR",
      a2a_transfer: false,
      message: "Failed to sign peer assertion",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}
