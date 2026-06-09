import { NextResponse } from "next/server";
import { signAgentCard } from "@/lib/a2a-card-signer";

// A2A Agent Card for the Velora Inventario Agent — spec v0.3.x
//
// Discoverable by peer A2A agents at /api/agents/inventario/agent-card.
// No auth required (public metadata). Cached 5 minutes at the CDN/proxy layer.
//
// baseUrl pinned to canonical custom domain via A2A_PUBLIC_BASE_URL.
// Card is signed with EdDSA (JWS Compact) for MITM protection.
//
// Skills map to the five tool actions defined in inventario-agent-tools.ts:
//   - stock.consultar_stock       (read — autonomous)
//   - catalogo.consultar_precio   (read — autonomous)
//   - stock.gestionar_stock       (HITL mutation)
//   - stock.transferir_entre_sucursales (HITL mutation)
//   - catalogo.gestionar_producto (HITL mutation)

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Inventario Agent",
    description:
      "Inventory and catalog management agent. Handles stock queries, low-stock alerts, " +
      "stock adjustments, physical count reconciliation (HITL gate), inter-location transfers, " +
      "and product catalog CRUD. Owner-only — all mutations require owner confirmation before " +
      "execution. Accepts Supervisor-delegated directives and returns structured intent results.",
    url: `${baseUrl}/api/agents/inventario/jsonrpc`,
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
        id: "inventario.stock.query",
        name: "Query Stock",
        description: "Returns current stock levels for one or all products, or filters low-stock items.",
        examples: [
          "¿cuántas Coca Cola me quedan?",
          "¿qué productos están por agotarse?",
          "mostrame el inventario completo",
        ],
      },
      {
        id: "inventario.stock.adjust",
        name: "Adjust Stock",
        description: "Proposes a stock adjustment (load, manual correction, or physical count) and awaits owner confirmation before executing.",
        examples: [
          "entraron 50 unidades de Fanta",
          "ajustá el stock de Sprite a 20",
          "hice un conteo y hay 35 Coca",
        ],
      },
      {
        id: "inventario.stock.transfer",
        name: "Transfer Between Locations",
        description: "Proposes a transfer of units between sucursales and awaits owner confirmation.",
        examples: [
          "mandá 10 Fanta de la sucursal centro a la del norte",
        ],
      },
      {
        id: "inventario.catalog.query",
        name: "Query Price",
        description: "Returns the price or stock of a product by name.",
        examples: [
          "¿cuánto vale la Coca?",
          "¿a qué precio tengo el Sprite?",
        ],
      },
      {
        id: "inventario.catalog.manage",
        name: "Manage Product Catalog",
        description: "Creates, edits (name/price/stock/description), deletes, or bulk-adjusts products. Price changes require owner confirmation.",
        examples: [
          "subí el precio de la Coca a $800",
          "creá el producto 'Agua San Luis 1.5L' a $350",
          "subí 10% todos los precios",
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
      kid: "velora-inventario-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/inventario/jwks`,
    },
  };

  const signed = signAgentCard(card, "inventario");

  return NextResponse.json(signed, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
