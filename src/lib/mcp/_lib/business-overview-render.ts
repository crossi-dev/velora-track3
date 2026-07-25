// src/lib/mcp/_lib/business-overview-render.ts — open_business_overview render tool + resource.
//
// ONE tool, ONE widget, two display modes — per the official MCP Apps Design Guidelines
// (claude.com/docs/connectors/building/mcp-apps/design-guidelines): "Start simple... the
// inline card might show a summary; fullscreen mode can offer the detailed view."
//
// A single tool call fetches EVERYTHING up front (inline summary fields + all four
// fullscreen tab payloads) so switching to fullscreen is instant, no second round trip.
// Zero new query logic — every field is resolved via the SAME backend ports the other
// tools already use:
//   - caja balance + shift status  → CajaBackend, same resolution as open_caja_status
//                                     (resolveCajaPrefill, imported from caja-status-render.ts).
//   - sales summary                → ReportesBackend.querySales, same call query_sales makes.
//   - pending cobros               → PaymentsBackend.listPendingOrders, same data open_pending_orders uses.
//   - low-stock products           → VentasBackend.getLowStockProducts, same data query_catalog's
//                                     stock field is drawn from (Product.reorderThreshold).
//   - suppliers / purchase reqs    → SupplierBackend.listSuppliers / listPurchaseRequests.
//   - customer 360                 → CustomerBackend.findCustomer, same lookup find_customer uses.
//   - margin / ranking / by-employee → ReportesBackend.querySales (margen, ranking_productos,
//                                     por_empleado metrics), same calls query_sales makes.
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
import type { PaymentsBackend, PendingOrder } from "./payments-backend.port";
import type { VentasBackend, LowStockProductResult } from "./ventas-backend.port";
import type { ReportesBackend } from "./reportes-backend.port";
import type { SupplierBackend, ListSuppliersResult } from "./supplier-backend.port";
import type { CustomerBackend } from "./customer-backend.port";
import { errResponse } from "./mcp-responses";
import { BUSINESS_OVERVIEW_HTML } from "../widgets/generated/business-overview.html";

/** Canonical ui:// URI for the business-overview widget resource. */
export const BUSINESS_OVERVIEW_RESOURCE_URI = "ui://business-overview";

/** The six existing backend ports this tool aggregates — no new ports introduced. */
export interface BusinessOverviewBackends {
  caja: CajaBackend;
  payments: PaymentsBackend;
  ventas: VentasBackend;
  reportes: ReportesBackend;
  supplier: SupplierBackend;
  customer: CustomerBackend;
}

type TabId = "cliente_360" | "cierre_dia" | "reposicion_stock" | "dashboard_ventas";

interface VentasPeriodo {
  saleCount: number;
  totalRevenue: number;
  totalRevenueFormatted: string;
  /** true when this section's query_sales call errored/failed to parse — the
   * widget shows "no pudimos cargar" instead of a confident "0 ventas", so a
   * backend timeout never reads as "you sold nothing today." */
  failed?: boolean;
}

interface Margen {
  revenueFormatted: string;
  costFormatted: string;
  marginFormatted: string;
  marginPercent: number;
  costCoverage: string;
}

interface RankingEntry {
  rank: number;
  product: string;
  unitsSold: number;
}

interface PorEmpleadoEntry {
  employee: string;
  saleCount: number;
  totalRevenueFormatted: string;
}

interface HistorialClienteOrder {
  date: string;
  total: string;
  items: Array<{ product: string; qty: number }>;
}

interface HistorialCliente {
  lifetimeOrderCount: number;
  lifetimeTotalSpent: string;
  recentOrders: HistorialClienteOrder[];
}

type Cliente360Data =
  | { status: "empty" }
  | { status: "not_found"; query: string }
  | { status: "ambiguous"; query: string; matches: string[] }
  | {
      status: "found";
      customer: { name: string; phone: string | null; email: string | null; address: string | null; city: string | null };
      historial: HistorialCliente | null;
      pendingOrders: ReturnType<typeof toPendingSummary>[];
    };

/** Parses the CallToolResult query_sales returns. Defensive: query_sales cannot actually
 *  error for these presets, but we never trust a JSON.parse blindly. */
function parseJson<T>(result: CallToolResult, fallback: T): T {
  if (result.isError) return fallback;
  const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseVentasPeriodo(result: CallToolResult): VentasPeriodo {
  const parsed = parseJson<VentasPeriodo | null>(result, null);
  if (parsed) return parsed;
  return { saleCount: 0, totalRevenue: 0, totalRevenueFormatted: "$ 0", failed: true };
}

// Caps mirror pending-orders.tsx's DISPLAY_CAP=10 convention for widget lists.
const LOW_STOCK_CAP = 10;
const PENDING_CAP = 10;
const SUPPLIER_CAP = 20;
const PURCHASE_REQUEST_CAP = 10;

function toPendingSummary(po: PendingOrder) {
  return {
    id: po.id,
    customerName: po.customerName,
    totalARS: po.totalARS,
    itemCount: po.items.length,
    createdAt: po.createdAt.toISOString(),
  };
}

async function resolveCliente360(
  businessId: string,
  customer: CustomerBackend,
  reportes: ReportesBackend,
  customerName: string | undefined,
  allPendingOrders: PendingOrder[],
): Promise<Cliente360Data> {
  const rawName = customerName?.trim();
  if (!rawName) return { status: "empty" };

  const matches = await customer.findCustomer({ tenantId: businessId, name: rawName });
  if (matches.length === 0) return { status: "not_found", query: rawName };
  if (matches.length > 1) return { status: "ambiguous", query: rawName, matches: matches.map((m) => m.name) };

  const match = matches[0];
  const historialRaw = await reportes.querySales({
    tenantId: businessId,
    metrica: "historial_cliente",
    customer_name: match.name,
  });
  const historial = parseJson<HistorialCliente | null>(historialRaw, null);

  const pendingOrders = allPendingOrders.filter((po) => po.customerName === match.name).map(toPendingSummary);

  return {
    status: "found",
    customer: { name: match.name, phone: match.phone, email: match.email, address: match.address, city: match.city },
    historial,
    pendingOrders,
  };
}

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

  // Render tool: aggregate everything the inline summary AND the four fullscreen tabs
  // need, in one round trip.
  registerAppTool(
    server,
    "open_business_overview",
    {
      title: "Open business overview",
      description:
        "Use this as the DEFAULT entry point when the owner asks a general, open-ended question " +
        "about their business — e.g. 'veamos mi negocio', 'cómo va mi negocio', 'resumen del negocio', " +
        "'how's my business doing', or similar. Opens ONE dashboard widget: an inline snapshot " +
        "(cash register, today's/this week's sales, pending cobros, low stock) that the owner can " +
        "expand to a fullscreen panel with four tabs — Cliente 360 (customer lookup + order history), " +
        "Cerrar el día (end-of-day close: caja + today's sales + pending cobros), Reposición de stock " +
        "(low stock + suppliers + purchase requests), and Dashboard de ventas (margin, product ranking, " +
        "sales by employee). Side-effect-free — no sale, no charge, no mutation. Pass `customerName` " +
        "to open directly on the Cliente 360 tab pre-searched for that customer (e.g. when the owner " +
        "asks 'qué me debe Fulano' or 'historial de María').",
      _meta: {
        ui: { resourceUri: BUSINESS_OVERVIEW_RESOURCE_URI },
        "openai/outputTemplate": BUSINESS_OVERVIEW_RESOURCE_URI,
      },
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {
        customerName: z
          .string()
          .optional()
          .describe("Optional customer name to pre-search on the Cliente 360 tab, opening straight into fullscreen."),
        defaultTab: z
          .enum(["cliente_360", "cierre_dia", "reposicion_stock", "dashboard_ventas"])
          .optional()
          .describe("Optional fullscreen tab to open directly into. Defaults to cierre_dia."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ customerName, defaultTab }) => {
      try {
        const [
          caja,
          ventasHoyRaw,
          ventasSemanaRaw,
          pendingOrdersRaw,
          lowStockRaw,
          suppliers,
          purchaseRequestsRaw,
          margenRaw,
          rankingRaw,
          porEmpleadoRaw,
        ] = await Promise.all([
          resolveCajaPrefill(businessId, backends.caja),
          backends.reportes.querySales({ tenantId: businessId, metrica: "ventas_periodo", preset: "hoy" }),
          backends.reportes.querySales({ tenantId: businessId, metrica: "ventas_periodo", preset: "semana" }),
          backends.payments.listPendingOrders({ tenantId: businessId }),
          backends.ventas.getLowStockProducts({ tenantId: businessId }),
          backends.supplier.listSuppliers({ tenantId: businessId }),
          backends.supplier.listPurchaseRequests({ tenantId: businessId }),
          backends.reportes.querySales({ tenantId: businessId, metrica: "margen", preset: "mes" }),
          backends.reportes.querySales({ tenantId: businessId, metrica: "ranking_productos", preset: "mes" }),
          backends.reportes.querySales({ tenantId: businessId, metrica: "por_empleado", preset: "mes" }),
        ]);

        const pendingOrders = pendingOrdersRaw.map(toPendingSummary);
        const lowStock = (lowStockRaw as LowStockProductResult[]).slice(0, LOW_STOCK_CAP);
        const ventasHoy = parseVentasPeriodo(ventasHoyRaw);
        const ventasSemana = parseVentasPeriodo(ventasSemanaRaw);
        const margen = parseJson<Margen | null>(margenRaw, null);
        const ranking = parseJson<{ ranking: RankingEntry[] }>(rankingRaw, { ranking: [] }).ranking;
        const porEmpleado = parseJson<{ byEmployee: PorEmpleadoEntry[] }>(porEmpleadoRaw, { byEmployee: [] }).byEmployee;

        const cliente360 = await resolveCliente360(businessId, backends.customer, backends.reportes, customerName, pendingOrdersRaw);

        const supplierNameById = new Map<string, string>((suppliers as ListSuppliersResult[]).map((s) => [s.id, s.name]));

        const prefill = {
          startInFullscreen: !!customerName || !!defaultTab,
          defaultTab: (defaultTab ?? (customerName ? "cliente_360" : "cierre_dia")) as TabId,
          summary: {
            caja,
            ventasHoy,
            ventasSemana,
            pendingCount: pendingOrders.length,
            lowStock,
          },
          cliente360,
          cierreDia: {
            caja,
            ventasHoy,
            pendingOrders: pendingOrders.slice(0, PENDING_CAP),
            pendingCount: pendingOrders.length,
          },
          reposicionStock: {
            lowStock,
            suppliers: suppliers.slice(0, SUPPLIER_CAP),
            purchaseRequests: purchaseRequestsRaw.slice(0, PURCHASE_REQUEST_CAP).map((pr) => ({
              id: pr.id,
              requestNumber: pr.requestNumber,
              issuedAt: pr.issuedAt,
              totalAmount: pr.totalAmount,
              currency: pr.currency,
              supplierName: pr.supplierId ? (supplierNameById.get(pr.supplierId) ?? null) : null,
            })),
          },
          dashboardVentas: { margen, ranking, porEmpleado },
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
