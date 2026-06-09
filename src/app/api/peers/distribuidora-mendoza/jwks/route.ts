// Distribuidora Mendoza — JWKS endpoint (GET).
//
// Serves the Ed25519 public key for this mock peer agent.
// The key is loaded from AGENT_IDENTITY_KEY_DISTRIBUIDORA_MENDOZA (PEM PKCS#8).
// Graceful degradation: if the key is not configured, returns an empty keyset.
//
// No auth required — JWKS endpoints are public.

import { NextResponse } from "next/server";
import { createPrivateKey, createPublicKey } from "crypto";
import { cloudLog } from "@/lib/cloud-logger";

const KID = "distribuidora-mendoza-v1";

function getPublicJwk(): { kid: string; kty: string; crv: string; x: string } | null {
  const pem = process.env.AGENT_IDENTITY_KEY_DISTRIBUIDORA_MENDOZA;
  if (!pem) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "PEER_KEY_MISSING",
      a2a_transfer: false,
      message: "AGENT_IDENTITY_KEY_DISTRIBUIDORA_MENDOZA not set — JWKS empty",
      data: {},
    });
    return null;
  }

  try {
    const privateKey = createPrivateKey({ key: pem, format: "pem" });
    const publicKey = createPublicKey(privateKey);
    const jwk = publicKey.export({ format: "jwk" }) as { x?: string };
    if (!jwk.x) throw new Error("JWK missing x field");
    return { kid: KID, kty: "OKP", crv: "Ed25519", x: jwk.x };
  } catch (err) {
    cloudLog({
      severity: "ERROR",
      component: "A2A",
      action: "PEER_KEY_PARSE_ERROR",
      a2a_transfer: false,
      message: "Failed to parse AGENT_IDENTITY_KEY_DISTRIBUIDORA_MENDOZA",
      data: { error: err instanceof Error ? err.message : String(err) },
    });
    return null;
  }
}

export function GET() {
  const key = getPublicJwk();
  const keyset = { keys: key ? [key] : [] };

  return NextResponse.json(keyset, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
