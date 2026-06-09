import { NextResponse } from "next/server";
import { getPublicJwk } from "@/lib/agent-identity";

// JWKS endpoint for the Velora Inventario Agent.
// Peer agents use this to verify X-Agent-Assertion JWTs signed by Inventario.
//
// No auth required (public key material is safe to expose).
// Cache 5 minutes — keys rotate infrequently; JWKS consumers should respect
// Cache-Control rather than caching indefinitely.

export function GET() {
  const jwk = getPublicJwk("inventario");

  if (!jwk) {
    // Key not configured — return empty JWKS so discovery does not hard-fail.
    // Callers will see no matching key and log CARD_JWKS_KEY_NOT_FOUND.
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
