// src/lib/mcp/connection-tools.ts — connection_status MCP tool registration.
//
// Returns the per-business BYOA integration readiness so the AI agent can guide
// the owner through connecting each missing service — without the owner needing
// to navigate the Settings UI manually.
//
// Integrations covered:
//   fiscal   — ARCA/AFIP electronic invoicing (delegates to getFiscalReadiness)
//   payments — MercadoPago OAuth (mpConnection row)
//   shipping — Andreani courier credentials (courierCredential row, provider=andreani)
//   whatsapp — Meta WABA connection or lower-tier phone signal
//   sms      — Twilio SMS (BusinessChannelCredential provider=twilio_sms)
//   email    — Resend transactional email (BusinessChannelCredential provider=resend)
//   pedidosya— PedidosYa delivery (BusinessChannelCredential provider=pedidosya)
//
// businessId comes exclusively from the server closure — never from tool input
// (tenant isolation rule, mirrored from fiscal-tools.ts and all stateful tools).
//
// Connect link: ALL integrations share the same secure Servicios tab deep-link.
//   OAuth integrations (payments, whatsapp): the dashboard kicks off the
//   provider's own authorize flow — credentials NEVER pass through chat.
//   Form integrations (fiscal, shipping, sms, email, pedidosya): the dashboard
//   renders a secure key/cert upload form — credentials NEVER pass through chat.
//
//   connectUrl format: ${VELORA_APP_URL}/dashboard?tab=servicios&provider=<key>
//   connectMethod:
//     "oauth"  — MercadoPago, Meta WhatsApp (authorize on provider's site)
//     "form"   — ARCA cert, Andreani/OCA keys, Twilio key, Resend key, PedidosYa token

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadBusinessCapabilities } from "@/lib/business-capabilities";
import { getFiscalReadiness } from "@/app/api/agents/fiscal/jsonrpc/_lib/fiscal-readiness";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IntegrationStatus {
  key: string;
  label: string;
  connected: boolean;
  missing: string[];
  guidance: string;
  /** Direct link to the Servicios tab in the Velora dashboard. Hand this to
   *  the owner so they can connect without navigating the UI manually. */
  connectUrl: string;
  /** "oauth" → the dashboard will redirect to the provider's authorization page.
   *  "form"  → the owner pastes a key or uploads a cert on Velora's secure page. */
  connectMethod: "oauth" | "form";
}

// ── Base URL helper ───────────────────────────────────────────────────────────

/** Per-integration deep-link to the Servicios tab.
 *  Appends ?provider=<key> so the dashboard can scroll/highlight the right row.
 *  An unknown provider param is harmless — the tab still opens correctly. */
function serviciosUrl(key: string): string {
  const base = (process.env.VELORA_APP_URL ?? "https://somosvelora.com").replace(/\/$/, "");
  return `${base}/dashboard?tab=servicios&provider=${key}`;
}

/**
 * OAuth-initiation URL for MercadoPago.
 * GET /api/integrations/mp/connect → 302 to auth.mercadopago.com.ar.
 * The route creates a fresh OAuthState (CSRF), builds the authorization URL,
 * and redirects the owner to the official MP authorization page server-side.
 * Reuses the existing /connect route — no new OAuth logic.
 */
function mpConnectUrl(): string {
  const base = (process.env.VELORA_APP_URL ?? "https://somosvelora.com").replace(/\/$/, "");
  return `${base}/api/integrations/mp/connect`;
}

// ── Guidance builders (warm, short, Rioplatense — agent-actionable) ───────────
// Each non-empty string instructs the agent what to tell the owner and includes
// the connectUrl so the agent can hand the owner a clickable link.

function paymentsGuidance(hasMp: boolean, hasAlias: boolean, url: string): string {
  if (hasMp || hasAlias) return "";
  return (
    "Conectá MercadoPago: vas a autorizar en el sitio de MercadoPago y volvés al dashboard listo. " +
    "También podés cargar tu alias o CBU para cobros por transferencia directa. " +
    `Entrá acá: ${url}`
  );
}

function shippingGuidance(connected: boolean, url: string): string {
  if (connected) return "";
  return (
    "Para cotizar y generar envíos con Andreani pegás tus credenciales de empresa en la página segura. " +
    `Entrá acá: ${url}`
  );
}

function whatsappGuidance(connected: boolean, url: string): string {
  if (connected) return "";
  return (
    "Conectá tu línea de WhatsApp Business: vas a autorizar en Meta y volvés al dashboard. " +
    `Entrá acá: ${url}`
  );
}

function smsGuidance(connected: boolean, url: string): string {
  if (connected) return "";
  return (
    "Conectá Twilio: pegás tu API key de Twilio en la página segura de Velora. " +
    `Entrá acá: ${url}`
  );
}

function emailGuidance(connected: boolean, url: string): string {
  if (connected) return "";
  return (
    "Conectá Resend: pegás tu API key de Resend en la página segura de Velora. " +
    `Entrá acá: ${url}`
  );
}

function pedidosYaGuidance(connected: boolean, url: string): string {
  if (connected) return "";
  return (
    "Conectá PedidosYa: pegás tu API token en la página segura de Velora. " +
    `Entrá acá: ${url}`
  );
}

// ── Shared integration-status builder (DRY — used by connection_status + onboarding-render) ──

/**
 * Builds the array of 7 integration statuses for the given business.
 * Exported so both connection_status and the open_onboarding render tool can
 * share the same data without duplication.
 */
export async function buildIntegrationStatuses(businessId: string): Promise<IntegrationStatus[]> {
  const [caps, fiscalReadiness] = await Promise.all([
    loadBusinessCapabilities(businessId),
    getFiscalReadiness(businessId),
  ]);

  // payments: connected when either MercadoPago OAuth OR alias/CBU is set
  const paymentsConnected = caps.mercadopago || caps.alias_cbu;
  const paymentsMissing: string[] = [];
  if (!caps.mercadopago) paymentsMissing.push("MercadoPago OAuth");
  if (!caps.alias_cbu) paymentsMissing.push("Alias / CBU para transferencias");

  // whatsapp: connected at either tier (WABA full signup or phone-only signal)
  const whatsappConnected = caps.whatsapp_business || caps.whatsapp_phone;
  const whatsappMissing: string[] = [];
  if (!caps.whatsapp_business) whatsappMissing.push("Conexión Meta WABA (Embedded Signup)");
  if (!caps.whatsapp_phone) whatsappMissing.push("Número de WhatsApp registrado");

  return [
    {
      key: "fiscal",
      label: "Facturación (ARCA)",
      connected: fiscalReadiness.ready,
      missing: fiscalReadiness.missing,
      guidance: fiscalReadiness.guidance,
      connectUrl: serviciosUrl("fiscal"),
      connectMethod: "form" as const,
    },
    {
      key: "payments",
      label: "Pagos (MercadoPago)",
      connected: paymentsConnected,
      missing: paymentsConnected ? [] : paymentsMissing,
      // connectUrl points to the OAuth-initiation route (GET /api/integrations/mp/connect)
      // which 302-redirects to auth.mercadopago.com.ar — owner authorizes on the official
      // MP site, Velora completes the connection via /api/integrations/mp/callback.
      // This implements the BYOA OAuth-redirect model (MCP 2025-11-25 standard).
      guidance: paymentsGuidance(caps.mercadopago, caps.alias_cbu, mpConnectUrl()),
      connectUrl: mpConnectUrl(),
      connectMethod: "oauth" as const,
    },
    {
      key: "shipping",
      label: "Envíos (Andreani/OCA)",
      connected: caps.andreani,
      missing: caps.andreani ? [] : ["Credenciales Andreani"],
      guidance: shippingGuidance(caps.andreani, serviciosUrl("shipping")),
      connectUrl: serviciosUrl("shipping"),
      connectMethod: "form" as const,
    },
    {
      key: "whatsapp",
      label: "WhatsApp",
      connected: whatsappConnected,
      missing: whatsappConnected ? [] : whatsappMissing,
      guidance: whatsappGuidance(whatsappConnected, serviciosUrl("whatsapp")),
      connectUrl: serviciosUrl("whatsapp"),
      connectMethod: "oauth" as const,
    },
    {
      key: "sms",
      label: "SMS (Twilio)",
      connected: caps.twilio_sms,
      missing: caps.twilio_sms ? [] : ["Credenciales Twilio SMS"],
      guidance: smsGuidance(caps.twilio_sms, serviciosUrl("sms")),
      connectUrl: serviciosUrl("sms"),
      connectMethod: "form" as const,
    },
    {
      key: "email",
      label: "Email (Resend)",
      connected: caps.resend,
      missing: caps.resend ? [] : ["API key de Resend"],
      guidance: emailGuidance(caps.resend, serviciosUrl("email")),
      connectUrl: serviciosUrl("email"),
      connectMethod: "form" as const,
    },
    {
      key: "pedidosya",
      label: "PedidosYa",
      connected: caps.pedidosya,
      missing: caps.pedidosya ? [] : ["API token de PedidosYa"],
      guidance: pedidosYaGuidance(caps.pedidosya, serviciosUrl("pedidosya")),
      connectUrl: serviciosUrl("pedidosya"),
      connectMethod: "form" as const,
    },
  ];
}

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers the `connection_status` tool on the given MCP server.
 * Called only when a verified businessId is available from the auth gate.
 * businessId comes from the closure — never from tool input.
 */
export function registerConnectionTools(
  server: McpServer,
  businessId: string,
): void {
  server.registerTool(
    "connection_status",
    {
      title: "Connection status",
      description:
        "Use this at the start of a session or when the owner asks about integrations — it shows what is connected and how to connect what is missing. " +
        "Returns the BYOA (Bring Your Own Account) integration readiness for the " +
        "authenticated business. " +
        "Returns { integrations: [{ key, label, connected, missing, guidance, connectUrl, connectMethod }] }. " +
        "When connected=true, missing is [] and guidance is an empty string. " +
        "When connected=false, missing lists absent items and guidance provides warm " +
        "Rioplatense-Spanish instructions on how to connect the service including the connectUrl. " +
        "connectUrl is the Velora dashboard Servicios deep-link — hand this to the owner to connect. " +
        "connectMethod: 'oauth' means the owner will authorize on the provider's site " +
        "(MercadoPago, Meta WhatsApp) — tell them 'vas a autorizar en [provider] y volvés'. " +
        "connectMethod: 'form' means the owner pastes a key or uploads a cert on Velora's secure page " +
        "(ARCA, Andreani, Twilio, Resend, PedidosYa) — tell them 'pegás tu clave en la página segura'. " +
        "Credentials NEVER pass through chat. " +
        "Read-only — no mutations.",
      inputSchema: {},
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      const integrations = await buildIntegrationStatuses(businessId);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ integrations }) }],
      };
    },
  );
}
