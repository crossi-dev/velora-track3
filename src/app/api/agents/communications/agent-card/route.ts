import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

// A2A Agent Card for the Velora Communications Agent — spec v0.3.x
//
// Discoverable by peer A2A agents at /api/agents/communications/agent-card.
// No auth required (public metadata). Cached 5 minutes at CDN/proxy layer.
//
// Scope: Web Push (VAPID/FCM), in-app ChatMessage writes.
// Out of scope: WhatsApp (thin lib, not an A2A peer).

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Communications Agent",
    description:
      "Outbound notifications coordinator. Sends Web Push (VAPID/FCM) to owners and employees, " +
      "and writes structured ChatMessage entries to the owner timeline. " +
      "Does NOT handle WhatsApp — that channel is managed separately.",
    url: `${baseUrl}/api/agents/communications/jsonrpc`,
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
        id: "comms.push.owner",
        name: "Send Owner Push",
        description:
          "Sends a Web Push notification to the business owner (VAPID/FCM). " +
          "Works even when the app is closed.",
        examples: [
          "notify owner that payment was confirmed",
          "push al dueño: stock bajo en producto X",
        ],
      },
      {
        id: "comms.push.employee",
        name: "Send Employee Push",
        description:
          "Sends a Web Push notification to a specific employee (VAPID/FCM).",
        examples: [
          "notify employee abc123 about new task",
          "push al empleado Juan: turno mañana a las 8",
        ],
      },
      {
        id: "comms.chat.owner",
        name: "Write Owner Chat Message",
        description:
          "Writes a structured alert or info message to the owner's in-app chat timeline.",
        examples: [
          "write alert to owner: stock below threshold",
          "mensaje info al dueño: venta registrada sin conexión",
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
      kid: "velora-communications-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/communications/jwks`,
    },
  };

  const signed = signAgentCard(card, "communications");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
