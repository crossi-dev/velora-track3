import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

// A2A Agent Card for the Velora Companion Agent — spec v0.3.x
//
// Discoverable by peer A2A agents at /api/agents/companion/agent-card.
// No auth required (public metadata). Cached 5 minutes at the CDN/proxy
// layer so repeated discovery calls do not hit the runtime.
//
// The Companion is the employee's on-shift assistant. It answers questions,
// applies business rules, and registers sale events. Destructive operations
// are RBAC-enforced inline — the Companion cannot mutate owner-only resources.

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Companion Agent",
    description:
      "The employee's on-shift assistant — answers questions, applies business rules, " +
      "registers sale events. Cannot mutate destructive operations (RBAC enforced inline). " +
      "Accepts natural-language employee messages and returns a response with optional " +
      "structured actions (sale registration, stock query results, etc.).",
    url: `${baseUrl}/api/agents/companion/jsonrpc`,
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
        id: "assist.companion.turn",
        name: "Process Companion Turn",
        description:
          "Accepts a natural-language employee message and returns the Companion's response: " +
          "plain-text answer plus optional structured actions (intent, matched entities, " +
          "sale draft, stock query result). RBAC is enforced — owner-only intents are " +
          "blocked with an explanatory message.",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "The employee's natural-language message (max 1000 chars).",
            },
            businessId: {
              type: "string",
              description: "Velora business CUID (20-30 lowercase alphanumeric chars).",
            },
            lang: {
              type: "string",
              enum: ["es-AR", "en"],
              description: "Response language. Defaults to es-AR.",
            },
            history: {
              type: "array",
              description: "Recent conversation turns (last 12 max).",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", enum: ["user", "assistant"] },
                  text: { type: "string" },
                },
                required: ["role", "text"],
              },
            },
          },
          required: ["text", "businessId"],
        },
        outputSchema: {
          type: "object",
          properties: {
            answer: {
              type: "string",
              description: "The Companion's conversational reply in the requested language.",
            },
            intent: {
              type: "string",
              description: "Classified intent (e.g. register_sale, stock_query, answer).",
            },
            actions: {
              type: "array",
              description: "Structured action payloads emitted by this turn (may be empty).",
            },
            rbacBlocked: {
              type: "boolean",
              description: "True when the intent was blocked by the RBAC policy.",
            },
          },
          required: ["answer"],
        },
        examples: [
          "vendí 3 alfajores a Juan",
          "cuánto stock queda de agua mineral",
          "registrá una venta de 2 gaseosas",
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
      kid: "velora-companion-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/companion/jwks`,
    },
  };

  const signed = signAgentCard(card, "companion");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
