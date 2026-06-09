import { NextResponse } from "next/server";
import { getPublicJwk } from "@/lib/agent-identity";

// JWKS endpoint for the Velora Customer Agent.
// Peer agents use this to verify X-Agent-Assertion JWTs signed by the Customer Agent.
//
// No auth required (public key material). Cache 1 hour — keys rotate infrequently.

export function GET() {
  const jwk = getPublicJwk("customer");

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
