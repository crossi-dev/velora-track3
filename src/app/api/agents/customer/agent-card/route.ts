import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

// A2A Agent Card for the Velora Customer Agent — spec v0.3.x
//
// Discoverable by peer A2A agents at /api/agents/customer/agent-card.
// No auth required (public metadata). Cached 5 minutes.
//
// The Customer Agent Coordinator handles inbound customer interactions.
// Callers: Supervisor only (A2A assertion issuer = "supervisor").
//
// A2A Protocol v1.0: https://a2a-protocol.org/latest/specification/

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Customer Agent",
    description:
      "B2C Customer Agent Coordinator. Handles inbound customer interactions: " +
      "product catalog Q&A, customer profile capture, shipping quotes, payment links, " +
      "and owner escalation for out-of-scope legitimate inquiries. " +
      "Delegated from the Supervisor via A2A.",
    url: `${baseUrl}/api/agents/customer/jsonrpc`,
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
    defaultOutputModes: ["text"],
    skills: [
      {
        id: "customer.catalog.query",
        name: "Product Catalog Query",
        description: "Answers customer questions about available products and prices.",
        examples: ["¿Qué alfajores tienen?", "¿Cuánto cuesta el aceite?"],
      },
      {
        id: "customer.profile.capture",
        name: "Customer Profile Capture",
        description: "Records customer name, address, postal code, city, and email.",
        examples: ["Me llamo Felipe", "Vivo en Buenos Aires CP 1043"],
      },
      {
        id: "customer.shipping.quote",
        name: "Shipping Quote",
        description: "Returns shipping cost estimate for delivery to the customer's address.",
        examples: ["¿Cuánto cuesta el envío a Mendoza?"],
      },
      {
        id: "customer.payment.link",
        name: "Payment Link",
        description: "Creates a MercadoPago payment link for the customer to complete purchase.",
        examples: ["Quiero pagar", "Mandame el link"],
      },
      {
        id: "customer.escalation",
        name: "Owner Escalation",
        description: "Routes legitimate out-of-scope inquiries (bulk orders, partnerships) to the owner.",
        examples: ["¿Hacen pedidos por mayor?"],
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
      kid: "velora-customer-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/customer/jwks`,
    },
  };

  const signed = signAgentCard(card, "customer");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
