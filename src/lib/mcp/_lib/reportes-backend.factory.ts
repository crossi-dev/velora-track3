// src/lib/mcp/_lib/reportes-backend.factory.ts — ReportesBackend selection via REPORTES_BACKEND env var.
//
// Mirrors catalog-backend.factory.ts exactly:
//   - Reads process.env.REPORTES_BACKEND at CALL TIME (not module-load).
//   - Default is "velora" when unset / blank — safe for all existing deployments.
//   - Fail-loud on unknown values.
//
// Supported backends:
//   "velora"      (default) — VeloraReportesAdapter wrapping the ADK ventas-reportes-queries functions.
//   "tiendanube"            — TiendanubeReportesAdapter: aggregates Tiendanube order data.
//                            por_empleado is not supported on TN (returns errResponse).
//                            margen returns revenue only (no cost prices in TN orders).
//                            Credentials via BusinessChannelCredential(provider="tiendanube").
//
// Adding a new backend:
//   1. Implement `src/lib/mcp/_lib/<name>-reportes.adapter.ts` satisfying ReportesBackend.
//   2. Add a branch below: case "<name>": return new YourAdapter().
//   3. Add the string to SUPPORTED_BACKENDS.
//
// READ-ONLY: no idempotency or audit writes. The adapter is a pure query delegation layer.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ReportesBackend, QuerySalesInput } from "./reportes-backend.port";
import { errResponse } from "./mcp-responses";
import { TiendanubeReportesAdapter } from "./tiendanube-reportes.adapter";
import {
  resolveDateRange,
  fmtCurrency,
  queryVentasPeriodo,
  queryMargen,
  queryRankingProductos,
  queryPorEmpleado,
  queryHistorialCliente,
} from "@/lib/adk/tools/_lib/ventas-reportes-queries";

// ── Constant ──────────────────────────────────────────────────────────────────

const DEFAULT_CURRENCY = "ARS";

// ── VeloraReportesAdapter ─────────────────────────────────────────────────────

/**
 * Velora concrete implementation of ReportesBackend.
 *
 * Contains exactly the query logic previously inlined in the reportes-tools.ts
 * handler. Behavior is byte-for-byte identical — this is a pure extraction,
 * no logic was added or changed.
 */
class VeloraReportesAdapter implements ReportesBackend {
  async querySales(input: QuerySalesInput): Promise<CallToolResult> {
    const { tenantId: businessId, metrica, preset, from, to, limit = 10 } = input;

    // historial_cliente: date range not required.
    if (metrica === "historial_cliente") {
      const rawName = input.customer_name?.trim();
      if (!rawName) {
        return errResponse("MISSING_PARAM", "customer_name is required for historial_cliente.");
      }
      const result = await queryHistorialCliente(businessId, rawName, limit, DEFAULT_CURRENCY);
      if (result.kind === "not_found") {
        return errResponse("NOT_FOUND", `Customer "${rawName}" not found.`);
      }
      if (result.kind === "ambiguous") {
        return errResponse("AMBIGUOUS", `Multiple customers found: ${result.names.join(", ")}. Provide the exact name.`);
      }
      const { customer, lifetimeOrderCount, lifetimeTotalSpent, recentOrdersScope, recentOrders } = result;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ customer, lifetimeOrderCount, lifetimeTotalSpent, recentOrdersScope, recentOrders }),
        }],
      };
    }

    // All other metrics require a date range.
    const rangeResult = resolveDateRange(preset, from, to);
    if ("error" in rangeResult) {
      // Translate to English at the MCP boundary — the shared ADK helper returns
      // Spanish (used by Rioplatense supervisors); MCP error codes must be English.
      return errResponse(
        "INVALID_RANGE",
        "Supply both 'from' and 'to' (YYYY-MM-DD), or a preset: hoy|semana|mes.",
      );
    }
    const [dateFrom, dateTo] = rangeResult;
    const rangeLabel = preset ?? `${from} → ${to}`;

    if (metrica === "ventas_periodo") {
      const agg = await queryVentasPeriodo(businessId, dateFrom, dateTo);
      const total = Number(agg._sum.totalAmount ?? 0);
      const count = agg._count.id;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            period: rangeLabel,
            saleCount: count,
            totalRevenue: total,
            totalRevenueFormatted: fmtCurrency(total, DEFAULT_CURRENCY),
          }),
        }],
      };
    }

    if (metrica === "margen") {
      const items = await queryMargen(businessId, dateFrom, dateTo);
      let revenue = 0;
      let cost = 0;
      let itemsWithCost = 0;
      for (const item of items) {
        const qty = item.quantity;
        revenue += qty * Number(item.unitPrice);
        if (item.unitCost != null) { cost += qty * Number(item.unitCost); itemsWithCost++; }
      }
      const margin = revenue - cost;
      const marginPct = revenue > 0 ? (margin / revenue) * 100 : 0;
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            period: rangeLabel,
            revenue,
            revenueFormatted: fmtCurrency(revenue, DEFAULT_CURRENCY),
            cost,
            costFormatted: fmtCurrency(cost, DEFAULT_CURRENCY),
            margin,
            marginFormatted: fmtCurrency(margin, DEFAULT_CURRENCY),
            marginPercent: Math.round(marginPct * 10) / 10,
            costCoverage: `${itemsWithCost}/${items.length} lines have cost data`,
          }),
        }],
      };
    }

    if (metrica === "ranking_productos") {
      const ranking = await queryRankingProductos(businessId, dateFrom, dateTo, limit);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ period: rangeLabel, ranking }),
        }],
      };
    }

    if (metrica === "por_empleado") {
      const byEmployee = await queryPorEmpleado(businessId, dateFrom, dateTo);
      const formatted = byEmployee.map((e) => ({
        ...e,
        totalRevenueFormatted: fmtCurrency(e.totalRevenue, DEFAULT_CURRENCY),
      }));
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ period: rangeLabel, byEmployee: formatted }),
        }],
      };
    }

    // Exhaustive guard — TypeScript flags missing branches at compile time.
    const _exhaustive: never = metrica;
    return errResponse("UNKNOWN_METRIC", `Metric not implemented: ${_exhaustive as string}`);
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

const SUPPORTED_BACKENDS = ["velora", "tiendanube"] as const;
type SupportedBackend = (typeof SUPPORTED_BACKENDS)[number];

/**
 * Returns a ReportesBackend instance for the active backend.
 *
 * Resolution order (first non-blank wins):
 *   1. tenantOverride    — per-tenant slug from TenantToolConfig (null = not set)
 *   2. REPORTES_BACKEND  — global env var
 *   3. "velora"          — hard default
 *
 * Throws on any unrecognised value — fail-loud, not silent-fallback.
 */
export function createReportesBackend(tenantOverride?: string | null): ReportesBackend {
  const raw = (tenantOverride ?? process.env.REPORTES_BACKEND ?? "").trim() || "velora";

  if (!(SUPPORTED_BACKENDS as readonly string[]).includes(raw)) {
    throw new Error(
      `Unknown REPORTES_BACKEND="${raw}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
    );
  }
  const backend = raw as SupportedBackend;

  switch (backend) {
    case "velora":
      return new VeloraReportesAdapter();

    case "tiendanube":
      return new TiendanubeReportesAdapter();

    default: {
      const _exhaustive: never = backend;
      void _exhaustive;
      throw new Error(
        `Unknown REPORTES_BACKEND="${backend}". Supported backends: ${SUPPORTED_BACKENDS.join(", ")}.`,
      );
    }
  }
}
