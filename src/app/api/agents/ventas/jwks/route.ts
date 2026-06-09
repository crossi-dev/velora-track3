import { NextResponse } from "next/server";
import { getPublicJwk } from "@/lib/agent-identity";

// JWKS endpoint for the Velora Ventas Agent.
// Peer agents use this to verify X-Agent-Assertion JWTs signed by the Ventas Agent.
//
// No auth required (public key material is safe to expose).
// Cache 5 minutes — keys rotate infrequently.

export function GET() {
  const jwk = getPublicJwk("ventas");

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
