import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

// A2A Agent Card for the Velora Logística Agent — spec v0.3.x.
// Discoverable at /api/agents/logistica/agent-card.
// No auth required (public metadata). Cached 5 minutes.

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;
  const provider = process.env.LOGISTICA_PROVIDER ?? "andreani";

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Logística Agent",
    description:
      `Logistics role-agent. Routes shipment operations to the active provider (${provider}). ` +
      "Quotes shipment costs, creates dispatch orders and labels, and tracks delivery status. " +
      "Provider is swappable via LOGISTICA_PROVIDER env var — no orchestrator changes required. " +
      "Bilingual ES/EN.",
    url: `${baseUrl}/api/agents/logistica/jsonrpc`,
    version: "1.0.0",
    provider: {
      organization: "Velora",
      url: "https://somosvelora.com",
    },
    capabilities: {
      streaming: false,
      // pushNotifications and stateTransitionHistory are not implemented.
      // Advertising true would cause A2A 0.3.0 peers to call non-existent endpoints.
      // Set to false until the feature is built and tested.
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["data"],
    defaultOutputModes: ["data"],
    skills: [
      {
        id: "shipment.quote",
        name: "Shipment Quote",
        description:
          "Returns available services with price and estimated delivery days " +
          "for a given origin/destination postal code pair and package weight.",
        examples: [
          "quote shipment from 1001 to 5000, 2kg, declared $15000",
          "cotizar envío de CP 1001 a CP 5000",
        ],
      },
      {
        id: "shipment.create",
        name: "Shipment Create",
        description:
          "Creates a dispatch order linked to a Velora sale. " +
          "Returns tracking number, label PDF URL, and estimated delivery date.",
        examples: [
          "create shipment for sale abc123, domicilio service",
          "despachar pedido venta abc123 a Juan Pérez, domicilio",
        ],
      },
      {
        id: "shipment.track",
        name: "Shipment Track",
        description:
          "Returns the full event timeline for a tracking number. " +
          "Shows current status and all transit events.",
        examples: [
          "track ARK-biz123-1700000000000",
          "¿dónde está el envío ARK-biz123-1700000000000?",
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
      kid: "velora-logistica-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/logistica/jwks`,
    },
  };

  const signed = signAgentCard(card, "logistica");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
