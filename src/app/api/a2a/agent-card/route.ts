import { NextResponse } from "next/server";

// A2A Agent Card per spec v0.3.x
// https://a2a-protocol.org/latest/specification/
//
// Discoverable at /.well-known/agent-card.json (via next.config rewrite).
// External A2A clients hit this URL to learn what Velora's supervisor can do
// and how to authenticate before invoking message/send.
//
// Canonical baseUrl is hardcoded to the public custom domain regardless of
// which host this endpoint was accessed through. Avoids advertising the
// raw .run.app URL or the www variant inconsistently — peer A2A agents
// caching the card need ONE stable address. Override per-environment with
// A2A_PUBLIC_BASE_URL if needed (staging/preview).

const DEFAULT_PUBLIC_BASE_URL = "https://somosvelora.com";

export function GET() {
  const baseUrl = process.env.A2A_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;

  const card = {
    protocolVersion: "0.3.0",
    name: "Velora Supervisor",
    description:
      "Asistente IA para pequeños negocios y franquicias latinoamericanas (boutiques, pet shops, mini-markets, restaurantes). " +
      "Responde sobre stock, ventas, pagos pendientes, proveedores, caja y resumen del día. " +
      "Primer agente de habla hispana orientado a SMB en la red A2A.",
    url: `${baseUrl}/api/a2a/jsonrpc`,
    version: "1.0.0",
    provider: {
      organization: "Velora",
      url: "https://somosvelora.com",
    },
    documentationUrl: "https://somosvelora.com",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["text", "data"],
    defaultOutputModes: ["text", "data"],
    skills: [
      {
        id: "supervisor",
        name: "Velora Supervisor",
        description:
          "Procesa instrucciones complejas en castellano rioplatense para gestión de comercios pequeños. " +
          "Descompone pedidos multi-paso, resuelve referencias deícticas, y devuelve acciones estructuradas o respuestas conversacionales.",
        tags: [
          "smb",
          "argentina",
          "spanish",
          "rioplatense",
          "inventory",
          "sales",
          "commerce",
          "pyme",
        ],
        examples: [
          "cuánto vendí hoy",
          "qué tengo en stock",
          "quién me debe plata",
          "vendí 3 papas a Juan y cargué 50 clavos del proveedor X",
          "subí 10% papas y bajá 5% vinos",
        ],
        inputModes: ["text"],
        outputModes: ["text"],
      },
      {
        id: "employee-event-router",
        name: "Velora Employee Event Router",
        description:
          "Recibe eventos asíncronos del agente Empleado (LOW_STOCK, SHIFT_START, SHIFT_END) " +
          "y decide la prioridad de notificación al dueño: notify_now, daily_summary, o drop. " +
          "Diseñado para federación: una Sucursal publica eventos a su Supervisor local, y el Supervisor de " +
          "Franquicia agrega los eventos del nivel Sucursal sin tocar el flujo conversacional.",
        tags: [
          "agent-bus",
          "supervisor",
          "notifications",
          "federation",
          "franchise",
          "async",
        ],
        examples: [
          "EMPLOYEE_EVENT type:LOW_STOCK saleId:abc alerts:[pintura blanca 2/5]",
          "EMPLOYEE_EVENT type:SHIFT_START employeeId:emp-1",
        ],
        inputModes: ["text", "data"],
        outputModes: ["text", "data"],
      },
    ],
    // Contratos privados expuestos por este agente. Sirven para que un
    // peer (otro agente A2A) sepa qué payloads estructurados puede enviar
    // y qué shape va a recibir como decisión. Ver src/lib/agent-contract.ts.
    contracts: {
      consumes: [
        {
          id: "velora.employee.event",
          version: "1.0.0",
          description: "EmployeeEvent v1 — señales del agente Empleado al Supervisor.",
          eventTypes: [
            "LOW_STOCK",
            "SHIFT_START",
            "SHIFT_END",
            "CASH_AT_RISK",
            "BULK_IMPORT_COMPLETED",
            "CHAT_MESSAGE",
            "COMPANION_RESPONSE",
            "SUPERVISOR_QUERY",
            "STOCK_INGRESS_REQUEST",
          ],
        },
      ],
      emits: [
        {
          id: "velora.supervisor.notification",
          version: "1.0.0",
          description: "Decisión de prioridad de notificación: now | daily | drop.",
        },
        {
          id: "velora.supervisor.stock_ingress_decision",
          version: "1.0.0",
          description: "Decisión de aprobación de ingreso de stock: { approved, anomaly, reason }.",
        },
      ],
    },
    securitySchemes: {
      ApiKeyAuth: {
        type: "apiKey",
        name: "X-API-Key",
        in: "header",
        description: "API key de agente externo. Solicitar credenciales a hola@somosvelora.com.",
      },
    },
    security: [{ ApiKeyAuth: [] }],
    supportsAuthenticatedExtendedCard: false,
    contact: {
      name: "Velora",
      email: "hola@somosvelora.com",
      url: "https://somosvelora.com",
    },
    "x-rateLimits": {
      requestsPerMinutePerKey: 60,
      maxInputChars: 4000,
      retryAfterHeader: "Retry-After",
      errorCode: -32005,
    },
    "x-sla": {
      uptimePercent: 99,
      maxResponseMs: 8000,
      dataResidency: "southamerica-east1",
    },
    "x-errors": [
      { code: -32004, meaning: "Auth required — X-API-Key missing or invalid" },
      { code: -32005, meaning: "Rate limit exceeded — back off for Retry-After seconds" },
      { code: -32601, meaning: "Method not found" },
      { code: -32602, meaning: "Invalid params — message.parts must have at least one text part" },
    ],
    "x-agentIdentity": {
      kid: "velora-supervisor-v1",
      algorithm: "EdDSA",
      curve: "Ed25519",
      jwksUrl: `${baseUrl}/api/agents/supervisor/jwks`,
    },
  };

  return NextResponse.json(card, {
    headers: {
      "Cache-Control": "public, max-age=300",
      "Content-Type": "application/json",
    },
  });
}
