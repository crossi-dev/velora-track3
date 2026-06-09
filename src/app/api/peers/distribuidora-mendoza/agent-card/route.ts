// Distribuidora Mendoza — A2A Agent Card (GET).
//
// Serves the public metadata card for this mock peer agent.
// In a real deployment this would live at distribuidora-mendoza.com.ar.
// For the Velora demo the AgentCard lives here and addTrustedPeer uses
// "somosvelora.com/api/peers/distribuidora-mendoza" as the domain.
//
// No auth required — AgentCards are public metadata.

import { NextResponse } from "next/server";

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;
  const peerBase = `${baseUrl}/api/peers/distribuidora-mendoza`;

  const card = {
    protocolVersion: "0.3.0",
    name: "Distribuidora Mendoza",
    description:
      "Mayorista de consumo masivo para el mercado argentino. " +
      "Cotizaciones y órdenes de compra en tiempo real para productos de almacén, " +
      "bebidas, golosinas y limpieza. Entrega en 1-3 días hábiles.",
    url: `${peerBase}/jsonrpc`,
    version: "1.0.0",
    provider: {
      organization: "Distribuidora Mendoza S.A.",
      url: `https://${peerBase}`,
    },
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["data"],
    defaultOutputModes: ["text", "data"],
    skills: [
      {
        id: "wholesale.price.quote",
        name: "Cotización de precio mayorista",
        description:
          "Devuelve precio unitario, total, días de entrega y validez de la cotización " +
          "para un producto y cantidad dados.",
        tags: ["wholesale", "pricing", "quote"],
        examples: [
          "cotizame 50 cajas de Quilmes",
          "cuánto me salen 100 kg de harina Cañuelas",
          "precio mayorista de Fernet Branca x24",
        ],
        inputModes: ["data"],
        outputModes: ["text", "data"],
        inputSchema: {
          type: "object",
          required: ["productName", "qty"],
          properties: {
            productName: { type: "string", description: "Nombre del producto a cotizar" },
            qty: { type: "number", description: "Cantidad de unidades de venta mayorista" },
            deliveryPostalCode: { type: "string", description: "Código postal de entrega (opcional)" },
          },
        },
      },
      {
        id: "wholesale.order.create",
        name: "Crear orden de compra mayorista",
        description:
          "Crea una orden de compra para el producto y cantidad dados. " +
          "Retorna un orderId, precio total y fecha estimada de entrega.",
        tags: ["wholesale", "order", "purchase"],
        examples: [
          "comprá 50 cajas de Quilmes",
          "hacé un pedido de 200 kg de harina",
          "crear orden 30 cajas Fernet",
        ],
        inputModes: ["data"],
        outputModes: ["text", "data"],
        inputSchema: {
          type: "object",
          required: ["productName", "qty"],
          properties: {
            productName: { type: "string", description: "Nombre del producto" },
            qty: { type: "number", description: "Cantidad de unidades de venta mayorista" },
            deliveryPostalCode: { type: "string", description: "Código postal de entrega (opcional)" },
            buyerCuit: { type: "string", description: "CUIT del comprador (opcional)" },
            buyerName: { type: "string", description: "Nombre del comprador (opcional)" },
          },
        },
      },
    ],
    securitySchemes: {
      AgentAssertionAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Ed25519 JWT in X-Agent-Assertion header",
      },
    },
    security: [{ AgentAssertionAuth: [] }],
    "x-agentIdentity": {
      kid: "distribuidora-mendoza-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${peerBase}/jwks`,
    },
  };

  return NextResponse.json(card, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
