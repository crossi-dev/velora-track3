import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

// A2A Agent Card for the Velora Equipo Agent — spec v0.3.x
//
// Discoverable by peer A2A agents at /api/agents/equipo/agent-card.
// No auth required (public metadata). Cached 5 minutes at the CDN/proxy
// layer so repeated discovery calls do not hit the runtime.
//
// baseUrl is pinned to the canonical custom domain via A2A_PUBLIC_BASE_URL.
// Set that env var in staging/preview to avoid advertising the .run.app URL.
//
// v1.0: card is signed with EdDSA (JWS Compact) for MITM protection.
// v0.3.x clients that ignore the `signature` field remain compatible.

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Equipo Agent",
    description:
      "Employee and team management agent (RH). Handles employee onboarding, " +
      "schedule queries, PIN resets, permissions, and team composition for a business. " +
      "Accepts Supervisor-delegated directives and returns structured intent results.",
    url: `${baseUrl}/api/agents/equipo/jsonrpc`,
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
    defaultInputModes: ["text", "data"],
    defaultOutputModes: ["text", "data"],
    skills: [
      {
        id: "equipo.employee.create",
        name: "Create Employee",
        description: "Onboards a new employee with name, PIN, and optional role.",
        examples: [
          "crear empleado Juan con PIN 1234",
          "add employee María Pérez role=vendedor",
        ],
      },
      {
        id: "equipo.employee.update",
        name: "Update Employee",
        description: "Updates employee name, PIN, or role assignments.",
        examples: [
          "cambiar PIN de Juan a 5678",
          "update role for employee abc123",
        ],
      },
      {
        id: "equipo.team.list",
        name: "List Team",
        description: "Returns the current team roster for a business.",
        examples: [
          "quiénes son mis empleados?",
          "list all employees",
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
      kid: "velora-equipo-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/equipo/jwks`,
    },
  };

  const signed = signAgentCard(card, "equipo");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
