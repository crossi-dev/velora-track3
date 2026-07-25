// src/lib/mcp/server.ts — Velora MCP server factory.
//
// Exposes 14 tool packs (52 tools, 51 live in prod — connect_tiendanube hidden until
// TIENDANUBE_CLIENT_ID and TIENDANUBE_CLIENT_SECRET env vars are configured) over the
// Model Context Protocol:
//   Pure (always-on):
//   - validate_cuit        : CUIT/CUIL validation (no I/O)
//   Stateful (require verified businessId):
//   - fiscal pack          : get_fiscal_readiness, emit_invoice, emit_nota
//   - payments pack        : get_payment_intent_status, open_payment_link_wizard,
//                            create_tracked_payment_link, open_pending_orders,
//                            open_cobro_status, open_delivery_receipt
//   - logistica pack       : quote_shipping, create_shipment, track_shipment, get_package_profile
//   - ventas pack          : query_catalog, open_catalog_selector
//   - ventas + logistica   : open_shipment_prep (combined stock + shipping-quote widget;
//                            registers only when both packs are selected)
//   - caja + payments +    : open_business_panel (ONE widget, four tabs: Cliente 360,
//     ventas + reportes +    Cerrar el día, Reposición de stock, Dashboard de ventas;
//     supplier + customer    registers only when all six packs are selected)
//   - customer pack        : find_customer, upsert_customer, delete_customer
//   - messaging pack       : send_whatsapp_text, send_whatsapp_template
//   - catalog pack         : create_product, edit_product, stock_load, adjust_stock,
//                            delete_product, bulk_price_update
//   - supplier pack        : list_suppliers, create_supplier, create_purchase_request,
//                            edit_supplier, delete_supplier
//   - sales pack           : register_sale, register_movement, register_promesa_sale,
//                            confirm_promesa_payment, settle_promesa_payment, return_sale,
//                            open_sale_confirm
//   - caja pack            : caja_consultar_saldo, caja_ciclo_caja, caja_registrar_movimiento,
//                            open_caja_status
//   - reportes pack        : query_sales
//   - connection pack      : connection_status, open_onboarding
//   - onboarding pack      : connect_mercadopago, connect_pedidosya,
//                            connect_whatsapp, connect_tiendanube (hidden when TIENDANUBE_* absent),
//                            upload_catalog
//
// Transport: WebStandardStreamableHTTPServerTransport (stateless mode) — no
// sessionIdGenerator means no session state is kept in memory. Correct for
// tools that are pure functions and for Cloud Run's horizontal scaling.
//
// References:
//   MCP TypeScript SDK 1.29.0 — @modelcontextprotocol/sdk/server
//   MCP Streamable HTTP spec — modelcontextprotocol.io/specification/2025-11-05/

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { parseCuit, describePersonType } from "@/lib/cuit";
import { registerFiscalTools } from "./fiscal-tools";
import { registerPaymentsTools } from "./payments-tools";
import { registerLogisticaTools } from "./logistica-tools";
import { registerVentasTools } from "./ventas-tools";
import { registerMessagingTools } from "./messaging-tools";
import { registerCustomerTools } from "./customer-tools";
import { registerCatalogTools } from "./catalog-tools";
import { registerSupplierTools } from "./supplier-tools";
import { registerSalesTools } from "./sales-tools";
import { registerCajaTools } from "./caja-tools";
import { registerReportesTools } from "./reportes-tools";
import { registerConnectionTools } from "./connection-tools";
import { registerOnboardingTools } from "./onboarding-tools";
import { registerOnboardingRenderTool } from "./_lib/onboarding-render";
import { registerSaleConfirmRenderTool } from "./_lib/sale-confirm-render";
import { registerCajaStatusRenderTool } from "./_lib/caja-status-render";
import { registerShipmentPrepRenderTool } from "./_lib/shipment-prep-render";
import { registerBusinessPanelRenderTool } from "./_lib/business-panel-render";
import { resolveTenantBackendMap } from "./_lib/tenant-tool-config";
import { createCatalogBackend } from "./_lib/catalog-backend.factory";
import { createCustomerBackend } from "./_lib/customer-backend.factory";
import { createFiscalBackend } from "./_lib/fiscal-backend.factory";
import { createLogisticaBackend } from "./_lib/logistica-backend.factory";
import { createMessagingBackend } from "./_lib/messaging-backend.factory";
import { createPaymentsBackend } from "./_lib/payments-backend.factory";
import { createSupplierBackend } from "./_lib/supplier-backend.factory";
import { createVentasBackend } from "./_lib/ventas-backend.factory";
import { createCajaBackend } from "./_lib/caja-backend.factory";
import { createSalesBackend } from "./_lib/sales-backend.factory";
import { createReportesBackend } from "./_lib/reportes-backend.factory";

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Builds and returns a configured McpServer instance.
 * Pure tools (validate_cuit) are always registered.
 * When a verified businessId is supplied, stateful tool packs are registered
 * with per-tenant backend overrides resolved from TenantToolConfig.
 *
 * Resolution: TenantToolConfig override → global env var → "velora".
 * Empty table / absent row → all env var → identical behaviour to today.
 *
 * Each call returns a fresh server — the route handler creates one per request
 * in stateless mode.
 */
// Server-level onboarding returned in the MCP `initialize` response. Per the MCP
// spec, `instructions` is sent to every client on connect and folded into its
// context — the canonical, engine-agnostic place to orient any agent (Cowork,
// Codex, Gemini) the moment it loads the toolkit. Keep it short: it travels on
// every connection. The live, per-business connected/connectable map lives behind
// the `connection_status` tool (on-demand), not here.
// Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
const VELORA_MCP_INSTRUCTIONS =
  "Velora is an agentic-commerce toolkit for Argentine businesses, exposed over MCP. " +
  "It covers the full commerce cycle as tools: fiscal invoicing (ARCA), payments (MercadoPago), " +
  "logistics (Andreani/PedidosYa), product catalog, sales, cash register, and " +
  "messaging (WhatsApp/SMS/email).\n\n" +
  "Start here: call `connection_status` first. It returns, per integration, whether this business " +
  "has it connected and — for anything missing — warm step-by-step guidance plus a secure connect " +
  "link. Use it to onboard the owner instead of guessing what is available.\n\n" +
  "Tool names are capability-based, not vendor-based: e.g. `quote_shipping` routes to whichever " +
  "courier the business has connected, behind the scenes.\n\n" +
  "Safety: money and legal operations (register_sale, emit_invoice, caja " +
  "mutations) are real and irreversible — confirm intent with the owner before executing.\n\n" +
  "Communicate with the business owner in their language; default to Rioplatense Spanish (es-AR, voseo) only when they write in Spanish.\n\n" +
  "Rate limit: this MCP server enforces a limit of 60 calls per minute per tenant — pace tool discovery and bulk operations accordingly.";

export async function buildVeloraMcpServer(businessId?: string, packs?: string[]): Promise<McpServer> {
  // Toolset selection (GitHub/Stripe MCP pattern): when `packs` is provided, only the
  // named tool packs register (fewer tools per connection → fewer tokens). When omitted
  // or empty, ALL packs register (backward-compatible default). The always-on Pure pack
  // (validate_cuit) registers regardless. Pack keys are lowercase area names — see header.
  const wants = (pack: string) => !packs || packs.length === 0 || packs.includes(pack);

  const server = new McpServer(
    {
      name: "velora-mcp",
      version: "1.0.0",
    },
    { instructions: VELORA_MCP_INSTRUCTIONS },
  );

  // ── Tool: validate_cuit ────────────────────────────────────────────────────
  server.registerTool(
    "validate_cuit",
    {
      title: "Validate CUIT/CUIL",
      description:
        "Use this before using a CUIT in an invoice or fiscal operation to confirm it is mathematically valid. " +
        "Validates an Argentine CUIT or CUIL number. Returns parsed components (prefix, body, " +
        "check digit), person type, and whether the check digit is mathematically correct. " +
        "Accepts any format: raw digits, hyphened (20-12345678-9), or spaced. " +
        "Always returns a result — check the `valid` field; valid:false means the CUIT is " +
        "mathematically invalid or has an unrecognized prefix.",
      inputSchema: {
        cuit: z.string().describe("CUIT/CUIL in any format (digits, hyphens, or spaces)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => {
      const result = parseCuit(args.cuit);
      const description = describePersonType(result.personType);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...result, personTypeDescription: description }),
          },
        ],
      };
    },
  );

  // Register stateful tools only when a verified tenant businessId is present.
  // One DB query resolves per-tenant backend overrides; falls back to env var
  // and then "velora" for any null field — identical to today for all tenants.
  if (businessId) {
    const map = await resolveTenantBackendMap(businessId);
    if (wants("fiscal")) registerFiscalTools(server, businessId, createFiscalBackend(map.fiscal));
    if (wants("payments")) registerPaymentsTools(server, businessId, createPaymentsBackend(map.payments));
    if (wants("logistica")) registerLogisticaTools(server, businessId, createLogisticaBackend(map.logistica));
    if (wants("ventas")) registerVentasTools(server, businessId, createVentasBackend(map.ventas));
    // open_shipment_prep needs BOTH backends (catalog stock/weight + shipping quote) — one
    // widget combining two domains, per MCP Apps' one-tool-to-one-widget constraint. Only
    // registers when both packs are selected (pack-scoped connector filtering still applies).
    if (wants("ventas") && wants("logistica")) {
      registerShipmentPrepRenderTool(
        server,
        businessId,
        createVentasBackend(map.ventas),
        createLogisticaBackend(map.logistica),
      );
    }
    if (wants("customer")) registerCustomerTools(server, businessId, createCustomerBackend(map.customer));
    if (wants("messaging")) registerMessagingTools(server, businessId, createMessagingBackend(map.messaging));
    if (wants("catalog")) registerCatalogTools(server, businessId, createCatalogBackend(map.catalog));
    if (wants("supplier")) registerSupplierTools(server, businessId, createSupplierBackend(map.supplier));
    if (wants("sales")) {
      registerSalesTools(server, businessId, createSalesBackend(map.sales));
      // open_sale_confirm: visual preview→confirm for cash sales (render tool, no mutations here).
      registerSaleConfirmRenderTool(server, businessId);
    }
    // Caja factory uses its own CAJA_BACKEND env — not in TenantBackendMap.
    if (wants("caja")) {
      const cajaBackend = createCajaBackend();
      registerCajaTools(server, businessId, cajaBackend);
      // open_caja_status: visual shift state + action buttons (render tool, READ-ONLY here).
      registerCajaStatusRenderTool(server, businessId, cajaBackend);
    }
    if (wants("reportes")) registerReportesTools(server, businessId, createReportesBackend(map.reportes));
    // Connection status + graphical onboarding hub — both read-only, no credentials,
    // ship in the v1 published connector pack-set.
    // open_onboarding is intentionally in this pack (not onboarding) because it is a
    // read-only render tool (displays integration status + deep-links) — safe for
    // OpenAI-style connectors that exclude the credential-bearing onboarding pack.
    if (wants("connection")) {
      registerConnectionTools(server, businessId);
      registerOnboardingRenderTool(server, businessId);
    }
    // Onboarding write tools (connect_* + upload_catalog) — take raw credentials;
    // excluded from v1 connector pack-set per OpenAI connector policy.
    // connect_tiendanube is only registered when TIENDANUBE_CLIENT_ID and
    // TIENDANUBE_CLIENT_SECRET are configured — mirrors how other capability-gated
    // tools are handled (e.g. MP_NOT_CONFIGURED path in connect_mercadopago).
    // When the env vars are absent the live tool count is 50 instead of 51.
    if (wants("onboarding")) {
      const tiendanubeConfigured =
        !!process.env.TIENDANUBE_CLIENT_ID && !!process.env.TIENDANUBE_CLIENT_SECRET;
      registerOnboardingTools(server, businessId, { includeTiendanube: tiendanubeConfigured });
    }
    // open_business_panel: ONE widget, four tabs (Cliente 360, Cerrar el día, Reposición
    // de stock, Dashboard de ventas) — aggregates caja + payments + ventas + reportes +
    // supplier + customer reads. Only registers when all six packs are selected (mirrors
    // open_shipment_prep's dual-pack gate above, extended to six packs here).
    if (
      wants("caja") &&
      wants("payments") &&
      wants("ventas") &&
      wants("reportes") &&
      wants("supplier") &&
      wants("customer")
    ) {
      registerBusinessPanelRenderTool(server, businessId, {
        caja: createCajaBackend(),
        payments: createPaymentsBackend(map.payments),
        ventas: createVentasBackend(map.ventas),
        reportes: createReportesBackend(map.reportes),
        supplier: createSupplierBackend(map.supplier),
        customer: createCustomerBackend(map.customer),
      });
    }
  }

  return server;
}
