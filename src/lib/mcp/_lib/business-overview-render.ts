// src/lib/mcp/_lib/business-overview-render.ts — open_business_overview render tool + resource.
//
// READ-ONLY "front door" widget: aggregates four existing read paths into one screen
// so the owner can ask "veamos mi negocio" and get a snapshot in one shot. Zero new
// query logic — every field is resolved via the SAME backend ports the other tools
// already use:
//   - caja balance + shift status  → CajaBackend, same resolution as open_caja_status
//                                     (resolveCajaPrefill, imported from caja-status-render.ts).
//   - sales summary                → ReportesBackend.querySales, same call query_sales makes
//                                     (metrica="ventas_periodo", preset="hoy" / "semana").
//                                     NOTE: ReportesBackend exposes no "list all recent sales"
//                                     method (only aggregates + per-customer history) — using
//                                     two aggregate calls instead of inventing a new query.
//   - pending cobros count         → PaymentsBackend.listPendingOrders, same data open_pending_orders uses.
//   - low-stock products           → VentasBackend.getLowStockProducts, same data query_catalog's
//                                     stock field is drawn from, filtered by the EXISTING
//                                     Product.reorderThreshold column (default 5) — not a
//                                     hand-invented magic number.
//
// Tenant isolation: businessId ALWAYS comes from the closure parameter — never from tool input.
// Side-effect-free: no mutation, no idempotency needed. Navigation hops (open_caja_status,
// open_pending_orders) are fired from the WIDGET via callServerTool — this tool never calls them.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { CajaBackend } from "./caja-backend.port";
import { resolveCajaPrefill } from "./caja-status-render";
import type { PaymentsBackend } from "./payments-backend.port";
import type { VentasBackend } from "./ventas-backend.port";
import type { ReportesBackend } from "./reportes-backend.port";
import { errResponse } from "./mcp-responses";
import { BUSINESS_OVERVIEW_HTML } from "../widgets/generated/business-overview.html";

/** Canonical ui:// URI for the business-overview widget resource. */
export const BUSINESS_OVERVIEW_RESOURCE_URI = "ui://business-overview";

/** The four existing backend ports this tool aggregates — no new ports introduced. */
export interface BusinessOverviewBackends {
  caja: CajaBackend;
  payments: PaymentsBackend;
  ventas: VentasBackend;
  reportes: ReportesBackend;
}

interface SalesSummary {
  saleCount: number;
  totalRevenue: number;
  totalRevenueFormatted: string;
}

/** Parses the CallToolResult query_sales (ventas_periodo) returns. Defensive: query_sales
 *  cannot actually error for a "hoy"/"semana" preset, but we never trust a JSON.parse blindly. */
function parseVentasPeriodo(result: CallToolResult): SalesSummary {
  if (result.isError) return { saleCount: 0, totalRevenue: 0, totalRevenueFormatted: "$ 0" };
  const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
  try {
    const parsed = JSON.parse(raw) as {
      saleCount?: number;
      totalRevenue?: number;
      totalRevenueFormatted?: string;
    };
    return {
      saleCount: parsed.saleCount ?? 0,
      totalRevenue: parsed.totalRevenue ?? 0,
      totalRevenueFormatted: parsed.totalRevenueFormatted ?? "$ 0",
    };
  } catch {
    return { saleCount: 0, totalRevenue: 0, totalRevenueFormatted: "$ 0" };
  }
}

// Cap mirrors pending-orders.tsx's DISPLAY_CAP=10 convention for widget lists.
const LOW_STOCK_CAP = 10;

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers the ui://business-overview resource and the open_business_overview
 * render tool on the given server.
 *
 * READ-ONLY, side-effect-free. businessId comes from the closure — never from
 * tool input (tenant isolation).
 */
export function registerBusinessOverviewRenderTool(
  server: McpServer,
  businessId: string,
  backends: BusinessOverviewBackends,
): void {
  // Resource: self-contained HTML widget (bundled by build-widget.mjs).
  registerAppResource(
    server,
    "Resumen del negocio",
    BUSINESS_OVERVIEW_RESOURCE_URI,
    { _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: BUSINESS_OVERVIEW_HTML }],
    }),
  );

  // Render tool: aggregate caja + sales + pending cobros + low stock, pre-fill widget.
  registerAppTool(
    server,
    "open_business_overview",
    {
      title: "Open business overview",
      description:
        "Use this as the DEFAULT entry point when the owner asks a general, open-ended question " +
        "about their business — e.g. 'veamos mi negocio', 'cómo va mi negocio', 'resumen del negocio', " +
        "'how's my business doing', or similar. Opens a single read-only dashboard widget with a " +
        "snapshot of the whole business: cash register balance and shift status, today's and this " +
        "week's sales totals, how many cobros are still pending payment, and which products are " +
        "running low on stock. Side-effect-free — no sale, no charge, no mutation. " +
        "For a deeper dive into any one area, follow up with the specific tool " +
        "(caja_consultar_saldo/open_caja_status, query_sales, open_pending_orders, query_catalog).",
      _meta: {
        ui: { resourceUri: BUSINESS_OVERVIEW_RESOURCE_URI },
        "openai/outputTemplate": BUSINESS_OVERVIEW_RESOURCE_URI,
      },
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {},
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const [caja, pendingOrders, lowStockRaw, ventasHoyRaw, ventasSemanaRaw] = await Promise.all([
          resolveCajaPrefill(businessId, backends.caja),
          backends.payments.listPendingOrders({ tenantId: businessId }),
          backends.ventas.getLowStockProducts({ tenantId: businessId }),
          backends.reportes.querySales({ tenantId: businessId, metrica: "ventas_periodo", preset: "hoy" }),
          backends.reportes.querySales({ tenantId: businessId, metrica: "ventas_periodo", preset: "semana" }),
        ]);

        const prefill = {
          caja,
          ventasHoy: parseVentasPeriodo(ventasHoyRaw),
          ventasSemana: parseVentasPeriodo(ventasSemanaRaw),
          pendingCount: pendingOrders.length,
          lowStock: lowStockRaw.slice(0, LOW_STOCK_CAP),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(prefill) }],
          structuredContent: { prefill },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return errResponse("BUSINESS_OVERVIEW_ERROR", message);
      }
    },
  );
}
