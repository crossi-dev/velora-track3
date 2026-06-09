// src/lib/mcp/_lib/onboarding-render.ts — open_onboarding render tool + resource.
//
// Registers the ui://onboarding widget resource and the open_onboarding tool.
// The widget is a READ-ONLY connection hub: it shows the business's integration
// status (7 integrations) and offers launcher buttons that open Velora's official
// connect/import pages in the browser via app.openLink.
//
// No auth flows are implemented here — the widget is a status display + launcher.
// Zero custom flows; all connect flows live in the Velora dashboard.
//
// Tenant isolation: businessId ALWAYS comes from the closure — never from tool input.
//
// Render data contract (structuredContent.prefill):
//   { integrations: IntegrationStatus[], baseUrl: string }
//   Widget concats baseUrl + path for each action button's href.
//
// MCP App widget spec:
//   openai/outputTemplate — ChatGPT's primary render key (same ui:// target as resourceUri)
//   outputSchema.prefill  — required for ChatGPT to render the widget
//   openLinks capability  — declared by the HOST (AppBridge) not the app widget;
//                           app.openLink() will return isError:true if host denies.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { buildIntegrationStatuses } from "../connection-tools";
import { ONBOARDING_HTML } from "../widgets/generated/onboarding.html";

/** Canonical ui:// URI for the onboarding connection-hub widget resource.
 *  No @v2 suffix — the @ breaks ChatGPT's template fetch. */
export const ONBOARDING_RESOURCE_URI = "ui://onboarding";

// ── Base URL helper ───────────────────────────────────────────────────────────

function baseUrl(): string {
  return (process.env.VELORA_APP_URL ?? "https://somosvelora.com").replace(/\/$/, "");
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers the ui://onboarding resource and the open_onboarding render tool
 * on the given server.
 *
 * Side-effect-free (READ-ONLY). businessId comes from the closure — never from
 * tool input (tenant isolation).
 */
export function registerOnboardingRenderTool(
  server: McpServer,
  businessId: string,
): void {
  // Resource: self-contained HTML widget (bundled by build-widget.mjs).
  // CSP: self-contained — no external origins needed. openLink opens the host's
  // native browser, not a connect-domain from the widget iframe perspective.
  registerAppResource(
    server,
    "Conectá tu negocio",
    ONBOARDING_RESOURCE_URI,
    { _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: ONBOARDING_HTML }],
    }),
  );

  // Render tool: fetch integration statuses, pre-fill widget.
  registerAppTool(
    server,
    "open_onboarding",
    {
      title: "Open onboarding hub",
      description:
        "Use this when the owner wants a VISUAL hub of integrations with one-click connect buttons. For a JSON status read without a widget, use `connection_status` instead. " +
        "Opens the onboarding connection hub — a read-only widget showing which " +
        "integrations the business has connected (MercadoPago, WhatsApp, ARCA, " +
        "Andreani, Twilio, Resend, PedidosYa) and offering launcher buttons that " +
        "open Velora's official connect/import pages in the browser. " +
        "Side-effect-free — no mutations.",
      _meta: {
        ui: { resourceUri: ONBOARDING_RESOURCE_URI },
        "openai/outputTemplate": ONBOARDING_RESOURCE_URI,
      },
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const integrations = await buildIntegrationStatuses(businessId);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ integrations }) }],
          structuredContent: { prefill: { integrations, baseUrl: baseUrl() } },
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ code: "ONBOARDING_STATUS_ERROR", message: "No pudimos cargar el estado de integraciones." }) }],
          isError: true,
        };
      }
    },
  );
}
