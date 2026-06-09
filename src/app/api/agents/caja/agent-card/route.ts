import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

// A2A Agent Card for the Velora Caja Agent — spec v0.3.x.
// Discoverable at /api/agents/caja/agent-card.
// No auth required (public metadata). Cached 5 minutes.
//
// Caja Agent manages physical cash: shift open/close (arqueo),
// real-time balance, and ad-hoc cash movements.
// Source: Square CashDrawerShift API
//   https://developer.squareup.com/reference/square/objects/CashDrawerShift

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Caja Agent",
    description:
      "Physical cash-drawer management role-agent. " +
      "Opens and closes cash shifts (arqueo), queries real-time cash balance from DB, " +
      "and registers ad-hoc cash movements (ingresos, gastos, retiros/sangrías). " +
      "All close-shift and movement operations require explicit owner confirmation (HITL). " +
      "Bilingual ES/EN.",
    url: `${baseUrl}/api/agents/caja/jsonrpc`,
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
    defaultInputModes: ["data"],
    defaultOutputModes: ["data"],
    skills: [
      {
        id: "caja.ciclo_caja",
        name: "Cash Shift Open/Close",
        description:
          "Opens a cash shift with a declared opening float, or closes a shift " +
          "by recording the physical cash count. Returns variance (shortage/overage). " +
          "Enforces HITL: shows arqueo delta before closing.",
        examples: [
          "Abrí la caja con $5000 de fondo",
          "Cerrá la caja, conté $12300",
        ],
      },
      {
        id: "caja.consultar_saldo",
        name: "Cash Balance Query",
        description:
          "Returns the real-time expected cash balance from DB: " +
          "opening float + inflows − outflows since shift open. Never invented.",
        examples: [
          "¿Cuánto hay en caja?",
          "Saldo actual de la caja",
        ],
      },
      {
        id: "caja.registrar_movimiento",
        name: "Cash Movement",
        description:
          "Records an ad-hoc cash movement: income, expense, withdrawal (sangría), " +
          "tax payment, or salary. Requires owner confirmation before writing.",
        examples: [
          "Registrá un gasto de $800 por electricidad",
          "Sangría de $2000",
          "Ingreso extra de $500 por venta de contado",
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
      kid: "velora-caja-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/caja/jwks`,
    },
  };

  const signed = signAgentCard(card, "caja");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
