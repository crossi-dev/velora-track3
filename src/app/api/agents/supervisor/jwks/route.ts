import { NextResponse } from "next/server";
import { getPublicJwk } from "@/lib/agent-identity";

// JWKS endpoint for the Velora Supervisor agent.
// Peer agents use this to verify X-Agent-Assertion JWTs signed by the Supervisor.
//
// No auth required (public key material is safe to expose).
// Cache 5 minutes — keys rotate infrequently.

export function GET() {
  const jwk = getPublicJwk("supervisor");

  if (!jwk) {
    // Key not configured yet — return an empty JWKS so discovery doesn't fail.
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
