import { NextResponse } from "next/server";
import { getPublicJwk } from "@/lib/agent-identity";
import { cloudLog } from "@/lib/cloud-logger";

// JWKS endpoint for the Velora OnboardingAgent.
// Peer agents fetch this to verify X-Agent-Assertion JWTs signed by the
// OnboardingAgent. No auth (public material). Returns an empty key set when
// AGENT_IDENTITY_KEY_ONBOARDING is not configured yet — discovery does not
// fail, but inbound assertions cannot be verified until the key is provisioned.

export function GET() {
  const jwk = getPublicJwk("onboarding");
  if (!jwk) {
    cloudLog({
      severity: "WARNING",
      component: "A2A",
      action: "ONBOARDING_JWKS_KEY_MISSING",
      a2a_transfer: false,
      message: "AGENT_IDENTITY_KEY_ONBOARDING not configured — JWKS returning empty keys",
    });
    return NextResponse.json({ keys: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ keys: [jwk] }, { headers: { "Cache-Control": "public, max-age=3600" } });
}
