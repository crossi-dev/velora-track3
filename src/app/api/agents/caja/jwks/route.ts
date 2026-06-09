import { NextResponse } from "next/server";
import { getPublicJwk } from "@/lib/agent-identity";

// JWKS endpoint for the Velora Caja Agent.
// Peer agents use this to verify X-Agent-Assertion JWTs signed by the Caja Agent.
//
// No auth required (public key material is safe to expose).
// Cache 1 hour — keys rotate infrequently.
// Fail-open: returns empty keys array when AGENT_IDENTITY_KEY_CAJA is not set.

export function GET() {
  const jwk = getPublicJwk("caja");

  if (!jwk) {
    return NextResponse.json(
      { keys: [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { keys: [jwk] },
    { headers: { "Cache-Control": "public, max-age=3600" } },
  );
}
