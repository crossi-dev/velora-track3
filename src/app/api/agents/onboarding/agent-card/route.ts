import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";
import { ONBOARDING_AGENT_CARD_META } from "@/lib/adk/onboarding-agent.contract";

// A2A 0.3.0 Agent Card for the Velora OnboardingAgent.
// Public discovery endpoint — peer agents fetch this to learn how to call us.
// Signed via signAgentCard (Ed25519 JWS Compact). Cached 5 min at the proxy.
//
// The agent today is invoked INTERNALLY from owner-handler.stages-onboarding-
// agent.ts. The JSON-RPC inbound endpoint is published as a stub so the card
// is structurally complete and external orchestrators can discover the agent;
// see /api/agents/onboarding/jsonrpc/route.ts for the wire-level handler.
//
// Card metadata source-of-truth is ONBOARDING_AGENT_CARD_META in the contract
// file — keep them in sync by editing the contract, not this route.

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;
  const meta = ONBOARDING_AGENT_CARD_META;

  const card = {
    protocolVersion: meta.protocolVersion,
    name: meta.name,
    description: meta.description,
    url: `${baseUrl}/api/agents/onboarding/jsonrpc`,
    version: meta.version,
    provider: meta.provider,
    capabilities: meta.capabilities,
    defaultInputModes: meta.defaultInputModes,
    defaultOutputModes: meta.defaultOutputModes,
    skills: meta.skills,
    securitySchemes: {
      ApiKeyAuth: { type: "apiKey", name: "X-API-Key", in: "header" },
    },
    security: [{ ApiKeyAuth: [] }],
    "x-agentIdentity": {
      kid: meta.identityKid,
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/onboarding/jwks`,
    },
  };

  const signed = signAgentCard(card, "onboarding");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
