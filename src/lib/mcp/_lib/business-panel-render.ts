// src/lib/mcp/_lib/business-panel-render.ts — open_business_panel render tool + resource.
//
// ONE tool → ONE widget with FOUR client-side tabs (MCP Apps / SEP-1865 only supports a
// 1:1 tool-to-widget mapping — there is no way to render four separately-registered
// tools' widgets side by side, so the tabs live inside a single widget instead of being
// four tools). All four tabs' data is resolved in this single handler and returned in
// one structuredContent.prefill — switching tabs client-side needs no extra tool call.
//
// Zero new query logic. Every field is resolved via the SAME backend ports the other
// tools already use:
//   - Cliente 360           → CustomerBackend.findCustomer (same as find_customer),
//                             ReportesBackend.querySales(historial_cliente) (same as
//                             query_sales), and PaymentsBackend.listPendingOrders
//                             filtered by customer name (same data open_pending_orders /
//                             open_cobro_status use — no new query).
//   - Cerrar el día         → resolveCajaPrefill (same as open_caja_status),
//                             ReportesBackend.querySales(ventas_periodo, "hoy"), and
//                             PaymentsBackend.listPendingOrders.
//   - Reposición de stock   → VentasBackend.getLowStockProducts (same as
//                             business-overview's low-stock section) and
//                             SupplierBackend.listSuppliers + listPurchaseRequests
//                             (listPurchaseRequests is a thin new port method that
//                             delegates to the EXISTING prismaPurchaseRequestRepository
//                             already used by GET /api/purchase-requests — no new query).
//   - Dashboard de ventas   → ReportesBackend.querySales for margen, ranking_productos,
//                             and por_empleado (same calls query_sales already exposes).
//
// Tenant isolation: businessId ALWAYS comes from the closure parameter — never from
// tool input. Side-effect-free — no mutation, no idempotency needed.

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
import { BUSINESS_PANEL_HTML } from "../widgets/generated/business-panel.html";

/** Canonical ui:// URI for the business-panel widget resource. */
export const BUSINESS_PANEL_RESOURCE_URI = "ui://business-panel";

/** The six existing backend ports this tool aggregates — no new ports introduced
 *  beyond the read-only listPurchaseRequests seam on SupplierBackend. */
export interface BusinessPanelBackends {
  caja: CajaBackend;
  payments: PaymentsBackend;
  ventas: VentasBackend;
  reportes: ReportesBackend;
  supplier: SupplierBackend;
  customer: CustomerBackend;
}

type TabId = "cliente_360" | "cierre_dia" | "reposicion_stock" | "dashboard_ventas";

// ── Response parsing helpers ────────────────────────────────────────────────────
// query_sales returns a CallToolResult (JSON text). Defensive: these metrics cannot
// actually error for a resolved date range, but we never trust JSON.parse blindly.

function parseJson<T>(result: CallToolResult, fallback: T): T {
  if (result.isError) return fallback;
  const raw = (result.content?.[0] as { text?: string } | undefined)?.text ?? "{}";
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface VentasPeriodo {
  saleCount: number;
  totalRevenue: number;
  totalRevenueFormatted: string;
}

interface Margen {
  revenue: number;
  revenueFormatted: string;
  cost: number;
  costFormatted: string;
  margin: number;
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
  totalRevenue: number;
  totalRevenueFormatted: string;
}

interface HistorialClienteOrder {
  date: string;
  total: string;
  paymentMethod: string;
  items: Array<{ product: string; qty: number; unitPrice: string }>;
}

interface HistorialCliente {
  customer: string;
  lifetimeOrderCount: number;
  lifetimeTotalSpent: string;
  recentOrdersScope: string;
  recentOrders: HistorialClienteOrder[];
}

// Caps mirror pending-orders.tsx's DISPLAY_CAP=10 convention for widget lists.
const PENDING_CAP = 10;
const LOW_STOCK_CAP = 10;
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

// ── Cliente 360 resolution ───────────────────────────────────────────────────────

type Cliente360Data =
  | { status: "empty" }
  | { status: "not_found"; query: string }
  | { status: "ambiguous"; query: string; matches: string[] }
  | {
      status: "found";
      customer: {
        id: string;
        name: string;
        phone: string | null;
        email: string | null;
        address: string | null;
        city: string | null;
      };
      historial: HistorialCliente | null;
      pendingOrders: ReturnType<typeof toPendingSummary>[];
    };

async function resolveCliente360(
  businessId: string,
  backends: BusinessPanelBackends,
  customerName: string | undefined,
  allPendingOrders: PendingOrder[],
): Promise<Cliente360Data> {
  const rawName = customerName?.trim();
  if (!rawName) return { status: "empty" };

  const matches = await backends.customer.findCustomer({ tenantId: businessId, name: rawName });
  if (matches.length === 0) return { status: "not_found", query: rawName };
  if (matches.length > 1) {
    return { status: "ambiguous", query: rawName, matches: matches.map((m) => m.name) };
  }

  const customer = matches[0];
  const historialRaw = await backends.reportes.querySales({
    tenantId: businessId,
    metrica: "historial_cliente",
    customer_name: customer.name,
  });
  const historial = parseJson<HistorialCliente | null>(historialRaw, null);

  const pendingOrders = allPendingOrders
    .filter((po) => po.customerName === customer.name)
    .map(toPendingSummary);

  return {
    status: "found",
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      address: customer.address,
      city: customer.city,
    },
    historial,
    pendingOrders,
  };
}

// ── Registration ──────────────────────────────────────────────────────────────

/**
 * Registers the ui://business-panel resource and the open_business_panel render
 * tool on the given server.
 *
 * READ-ONLY, side-effect-free. businessId comes from the closure — never from
 * tool input (tenant isolation). Renders ONE widget with four client-side tabs
 * (Cliente 360, Cerrar el día, Reposición de stock, Dashboard de ventas) — all
 * data for all four tabs is fetched in this single call so switching tabs in the
 * widget is instant, with no extra tool round-trip.
 */
export function registerBusinessPanelRenderTool(
  server: McpServer,
  businessId: string,
  backends: BusinessPanelBackends,
): void {
  // Resource: self-contained HTML widget (bundled by build-widget.mjs).
  registerAppResource(
    server,
    "Panel del negocio",
    BUSINESS_PANEL_RESOURCE_URI,
    { _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } } } },
    (uri) => ({
      contents: [{ uri: uri.href, mimeType: RESOURCE_MIME_TYPE, text: BUSINESS_PANEL_HTML }],
    }),
  );

  registerAppTool(
    server,
    "open_business_panel",
    {
      title: "Open business panel",
      description:
        "Opens a single widget with FOUR tabs covering the whole business at a glance: " +
        "'Cliente 360' (one customer's sales history + pending cobros + WhatsApp contact — " +
        "pass customerName to preload it), 'Cerrar el día' (caja balance + today's sales + " +
        "pending cobros, for end-of-day reconciliation), 'Reposición de stock' (low-stock " +
        "products + suppliers + recent purchase requests), and 'Dashboard de ventas' " +
        "(margin, product ranking, and per-employee sales for the month). " +
        "Use this when the owner wants a deep multi-angle view, or names one of the four " +
        "areas by name ('cerrar caja', 'stock bajo', 'dashboard de ventas', 'cliente 360'). " +
        "For a lighter single-screen snapshot use open_business_overview instead. " +
        "All four tabs' data loads in this one call — switching tabs in the widget is " +
        "instant, no further tool calls needed. Side-effect-free — READ-ONLY, no mutation.",
      _meta: {
        ui: { resourceUri: BUSINESS_PANEL_RESOURCE_URI },
        "openai/outputTemplate": BUSINESS_PANEL_RESOURCE_URI,
      },
      outputSchema: { prefill: z.object({}).passthrough() },
      inputSchema: {
        customerName: z
          .string()
          .optional()
          .describe(
            "Customer name (fuzzy match) to preload in the Cliente 360 tab. When provided, " +
            "the widget opens on the Cliente 360 tab by default. Omit to open on Cerrar el día.",
          ),
        defaultTab: z
          .enum(["cliente_360", "cierre_dia", "reposicion_stock", "dashboard_ventas"])
          .optional()
          .describe(
            "Which tab to show first. Defaults to 'cierre_dia', or to 'cliente_360' " +
            "automatically when customerName is provided.",
          ),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    async (args) => {
      try {
        const [
          caja,
          ventasHoyRaw,
          pendingOrders,
          lowStockRaw,
          suppliers,
          purchaseRequestsRaw,
          margenRaw,
          rankingRaw,
          porEmpleadoRaw,
        ] = await Promise.all([
          resolveCajaPrefill(businessId, backends.caja),
          backends.reportes.querySales({ tenantId: businessId, metrica: "ventas_periodo", preset: "hoy" }),
          backends.payments.listPendingOrders({ tenantId: businessId }),
          backends.ventas.getLowStockProducts({ tenantId: businessId }),
          backends.supplier.listSuppliers({ tenantId: businessId }),
          backends.supplier.listPurchaseRequests({ tenantId: businessId }),
          backends.reportes.querySales({ tenantId: businessId, metrica: "margen", preset: "mes" }),
          backends.reportes.querySales({ tenantId: businessId, metrica: "ranking_productos", preset: "mes" }),
          backends.reportes.querySales({ tenantId: businessId, metrica: "por_empleado", preset: "mes" }),
        ]);

        const cliente360 = await resolveCliente360(businessId, backends, args.customerName, pendingOrders);

        const defaultTab: TabId = args.defaultTab ?? (args.customerName ? "cliente_360" : "cierre_dia");

        const supplierNameById = new Map<string, string>(
          (suppliers as ListSuppliersResult[]).map((s) => [s.id, s.name]),
        );

        const prefill = {
          defaultTab,
          cliente360,
          cierreDia: {
            caja,
            ventasHoy: parseJson<VentasPeriodo>(ventasHoyRaw, {
              saleCount: 0,
              totalRevenue: 0,
              totalRevenueFormatted: "$ 0",
            }),
            pendingOrders: pendingOrders.slice(0, PENDING_CAP).map(toPendingSummary),
            pendingCount: pendingOrders.length,
          },
          reposicionStock: {
            lowStock: (lowStockRaw as LowStockProductResult[]).slice(0, LOW_STOCK_CAP),
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
          dashboardVentas: {
            margen: parseJson<Margen | null>(margenRaw, null),
            ranking: parseJson<{ ranking: RankingEntry[] }>(rankingRaw, { ranking: [] }).ranking,
            porEmpleado: parseJson<{ byEmployee: PorEmpleadoEntry[] }>(porEmpleadoRaw, { byEmployee: [] }).byEmployee,
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(prefill) }],
          structuredContent: { prefill },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        return errResponse("BUSINESS_PANEL_ERROR", message);
      }
    },
  );
}
