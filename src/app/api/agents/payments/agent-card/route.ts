import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

// A2A Agent Card for the Velora Payments Agent — spec v0.3.x
//
// Discoverable by peer A2A agents at /api/agents/payments/agent-card.
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
    name: "Velora Payments Agent",
    description:
      "External payment orchestration agent. Creates MercadoPago checkout links, " +
      "checks payment status, and handles payment confirmations. " +
      "Supports LATAM payment rails.",
    url: `${baseUrl}/api/agents/payments/jsonrpc`,
    version: "1.0.0",
    provider: {
      organization: "Velora",
      url: "https://somosvelora.com",
    },
    capabilities: {
      streaming: false,
      // C-3: push is exclusively in the Communications agent (no VAPID/FCM code here).
      // A2A v0.3.0 §3: card MUST accurately describe capabilities.
      // https://a2a-protocol.org/latest/specification/#agent-card
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text", "data"],
    defaultOutputModes: ["text", "data"],
    skills: [
      {
        id: "payment.link.create",
        name: "Create Payment Link",
        description:
          "Creates a MercadoPago checkout preference and returns a payment URL " +
          "the customer can use to pay.",
        examples: [
          "create payment link for 5000 ARS customer Juan Pérez",
          "generar link de pago 12000 pesos",
        ],
      },
      {
        id: "payment.status",
        name: "Check Payment Status",
        description:
          "Checks the status of a MercadoPago payment by preference ID or payment ID.",
        examples: [
          "check status preference abc123",
          "estado del pago mp-456789",
        ],
      },
      {
        // M-1: previously undeclared tool — A2A v0.3.0 §3 requires all capabilities listed.
        id: "payment.promesa.confirm",
        name: "Confirm Promesa Payment",
        description:
          "Marks an existing PaymentIntent as confirmed with method='promesa' " +
          "(deferred payment / informal account). Triggers receipt, shipment, and " +
          "owner notification. Use when the owner says the customer will pay later.",
        examples: [
          "marcar pi_abc123 como promesa, el cliente paga en junio",
          "confirm promesa payment pi_xyz expectedAt 2026-07-01",
        ],
      },
      {
        // M-1: previously undeclared tool — A2A v0.3.0 §3 requires all capabilities listed.
        id: "payment.promesa.register",
        name: "Register Promesa Sale",
        description:
          "Creates a complete sale (Sale + SaleItems + Invoice + PaymentIntent) " +
          "as a promesa in one atomic step, then triggers receipt and WhatsApp. " +
          "Use when the owner combines sale details and promised payment in one message.",
        examples: [
          "registrar venta promesa: cliente Juan, 3 cajas aceite, paga en julio",
          "register promesa sale customer cust_123 items productId prod_456 qty 2",
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
      kid: "velora-payments-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/payments/jwks`,
    },
  };

  const signed = signAgentCard(card, "payments");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
