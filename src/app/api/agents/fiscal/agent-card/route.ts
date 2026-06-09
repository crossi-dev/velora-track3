import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Fiscal Agent",
    description:
      "Argentine tax authority (ARCA) integration agent. Validates CUIT/CUIL identifiers and emits electronic invoices (factura electrónica) with CAE. Bilingual ES/EN.",
    url: `${baseUrl}/api/agents/fiscal/jsonrpc`,
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
        id: "cuit.validate",
        name: "CUIT/CUIL Validation",
        description:
          "Validates Argentine CUIT or CUIL using check-digit algorithm. Returns formatted ID, person type, and validity.",
        examples: ["validate cuit 20-12345678-9", "validar cuil 27-41758101-5"],
      },
      {
        id: "factura.emit",
        name: "Electronic Invoice Emission",
        description:
          "Emits an ARCA-compliant electronic invoice (factura electrónica) and returns the CAE authorization code.",
        examples: ["emit invoice for cuit 20-12345678-9 amount 5000 type B"],
      },
      // A2A Protocol v1.0 §3: Agent Card MUST enumerate all agent capabilities.
      // comprobante.receipt is the PDF receipt generation use-case invoked by
      // trigger-fiscal-receipt.ts after a sale commits (A2A message/send dispatch).
      // Declaring it here makes the capability discoverable to peer A2A agents.
      // Source: https://a2a-protocol.org/latest/specification/#agent-card
      {
        id: "comprobante.receipt",
        name: "Sale Receipt Generation",
        description:
          "Generates a fiscal receipt for a completed sale. Called by the Supervisor after sale commit " +
          "to produce a PDF comprobante with CAE, amount, and customer details.",
        examples: [
          "generate receipt for sale invoiceId: inv_xxx customerCuit: 20-12345678-9 amount: 5000",
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
      kid: "velora-fiscal-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/fiscal/jwks`,
    },
  };

  const signed = signAgentCard(card, "fiscal");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
