import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

// A2A Agent Card for the Velora Supervisor Agent — spec v0.3.x
//
// Discoverable by peer A2A agents at /api/agents/supervisor/agent-card.
// No auth required (public metadata). Cached 5 minutes at the CDN/proxy
// layer so repeated discovery calls do not hit the runtime.
//
// baseUrl is pinned to the canonical custom domain via A2A_PUBLIC_BASE_URL.
// Set that env var in staging/preview to avoid advertising the .run.app URL.

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Supervisor Agent",
    description:
      "The business owner's general manager — orchestrates Contador, Ventas, and Logística. " +
      "Accepts natural-language owner messages and returns the orchestrated response, " +
      "delegating to role-agents (Fiscal, Payments, Logística) when needed. " +
      "Powers the owner-facing chat in Velora.",
    url: `${baseUrl}/api/agents/supervisor/jsonrpc`,
    version: "1.0.0",
    provider: {
      organization: "Velora",
      url: "https://somosvelora.com",
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text", "data"],
    skills: [
      {
        id: "orchestrate.owner.turn",
        name: "Orchestrate Owner Turn",
        description:
          "Accepts a natural-language message from the business owner and returns the " +
          "orchestrated response (text answer + optional structured actions). " +
          "The Supervisor may delegate internally to Contador, Ventas, or Logística " +
          "before replying. Payload must include a 'businessId: <id>' header line.",
        examples: [
          "businessId: clxyz123\nCuánto efectivo tengo en caja?",
          "businessId: clxyz123\nCreá un link de pago de $5000 para el cliente Juan",
          "businessId: clxyz123\nQué productos me quedan con bajo stock?",
        ],
      },
    ],
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        name: "X-API-Key",
        in: "header",
      },
    },
    security: [{ ApiKeyAuth: [] }],
    "x-agentIdentity": {
      kid: "velora-supervisor-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/supervisor/jwks`,
    },
  };

  const signed = signAgentCard(card, "supervisor");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
