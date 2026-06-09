import "server-only";
// ventas-reportes-tool.ts — Consolidated sales reporting tool (namespace: ventas.*).
//
// Replaces the broken `sales_summary` branch of business-query-tool.ts:
//   kind=sales_summary: no date filter (broken for "hoy"/"esta semana"),
//   margin: hallucinated (costPrice absent from context), ranking: fell to fallback.
//
// ONE tool, FIVE metrics via a `metrica` discriminant (Square SearchOrders pattern):
//   ventas_periodo    — revenue + count, real DB query with date filter
//   margen            — gross margin using SaleItem.unitCost (historical cost)
//   ranking_productos — best-sellers by units (Square /v2/catalog/search-catalog-items)
//   por_empleado      — revenue per employee (Square Labor /v1/load)
//   historial_cliente — recent orders for a customer
//
// Read-only — no idempotency needed.
//
// Sources (verified HTTP 200 2026-06-02):
//   Square SearchOrders: https://developer.squareup.com/reference/square/orders-api/search-orders
//   Square Labor:        https://developer.squareup.com/reference/square/labor-api
//   Prisma groupBy:      https://www.prisma.io/docs/orm/prisma-client/queries/aggregations-grouping-and-summarizing

import { z } from "zod";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import { createTool } from "./_shared/create-tool";
import {
  resolveDateRange,
  fmtCurrency,
  queryVentasPeriodo,
  queryMargen,
  queryRankingProductos,
  queryPorEmpleado,
  queryHistorialCliente,
} from "./_lib/ventas-reportes-queries";

// ── Backend port ───────────────────────────────────────────────────────────────

export interface VentasReportesBackend {
  businessId: string;
  /** Currency code for Intl.NumberFormat, e.g. "ARS". */
  currency: string;
}

// ── Zod input schema ───────────────────────────────────────────────────────────

const VentasReportesInput = z.object({
  metrica: z.enum(
    ["ventas_periodo", "margen", "ranking_productos", "por_empleado", "historial_cliente"],
    {
      errorMap: () => ({
        message:
          "Métrica inválida. Usar: ventas_periodo | margen | ranking_productos | por_empleado | historial_cliente.",
      }),
    },
  ),
  preset: z
    .enum(["hoy", "semana", "mes"])
    .optional()
    .describe("Rango predefinido. Mutuamente excluyente con from/to."),
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD")
    .optional()
    .describe("Fecha inicial YYYY-MM-DD. Requiere 'to'."),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato YYYY-MM-DD")
    .optional()
    .describe("Fecha final YYYY-MM-DD. Requiere 'from'."),
  customer_name: z
    .string()
    .min(1)
    .optional()
    .describe("Nombre o fragmento del cliente. Solo para historial_cliente."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe("Máximo de resultados (ranking / historial). Default 10, máx 50."),
});

// ── Genai schema (LLM calling convention) ─────────────────────────────────────

const VENTAS_REPORTES_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    metrica: {
      type: Type.STRING,
      description:
        "'ventas_periodo' = ingresos + cantidad en el período. " +
        "'margen' = margen bruto (ingreso − costo). " +
        "'ranking_productos' = más vendidos por unidades. " +
        "'por_empleado' = ingresos por empleado. " +
        "'historial_cliente' = compras de un cliente.",
    },
    preset: {
      type: Type.STRING,
      description: "Rango: 'hoy' | 'semana' | 'mes' (ART). Mutuamente excluyente con from/to.",
    },
    from: { type: Type.STRING, description: "Fecha inicial YYYY-MM-DD. Requiere 'to'." },
    to: { type: Type.STRING, description: "Fecha final YYYY-MM-DD. Requiere 'from'." },
    customer_name: { type: Type.STRING, description: "Nombre del cliente. Solo para historial_cliente." },
    limit: { type: Type.NUMBER, description: "Máx resultados para ranking/historial. Default 10." },
  },
  required: ["metrica"],
};

// ── Tool factory ───────────────────────────────────────────────────────────────

export function createVentasReportesTool(backend: VentasReportesBackend) {
  return createTool({
    name: "ventas.consultar_ventas",
    description:
      "Consulta métricas de ventas desde la DB. Usar para ingresos del día/semana/mes, " +
      "margen bruto, ranking de productos, ventas por empleado, o historial de un cliente. " +
      "SIEMPRE usar este tool — nunca inventar cifras de ventas desde el contexto.",
    schema: VENTAS_REPORTES_SCHEMA,
    inputSchema: VentasReportesInput,
    backend,
    execute: async ({ input, backend: b }) => {
      const { businessId, currency } = b;
      const { metrica, preset, from, to, limit = 10 } = input;

      // historial_cliente: date range not required.
      if (metrica === "historial_cliente") {
        const rawName = input.customer_name?.trim();
        if (!rawName) {
          return { error: { code: "MISSING_PARAM", message: "Requerido: customer_name para historial_cliente." } };
        }
        const result = await queryHistorialCliente(businessId, rawName, limit, currency);
        if (result.kind === "not_found") {
          return { error: { code: "NOT_FOUND", message: `No se encontró cliente "${rawName}".` } };
        }
        if (result.kind === "ambiguous") {
          return { error: { code: "AMBIGUOUS", message: `Varios clientes: ${result.names.join(", ")}. Especificá el nombre exacto.` } };
        }
        const { customer, lifetimeOrderCount, lifetimeTotalSpent, recentOrdersScope, recentOrders } = result;
        return {
          customer,
          lifetimeOrderCount,
          lifetimeTotalSpent,
          recentOrdersScope,
          recentOrders,
          message:
            lifetimeOrderCount === 0
              ? `${customer} no tiene compras registradas.`
              : `${customer}: ${lifetimeOrderCount} compra(s) en total, ${lifetimeTotalSpent} acumulado. ${recentOrdersScope}.`,
        };
      }

      // All other metrics need a date range.
      const rangeResult = resolveDateRange(preset, from, to);
      if ("error" in rangeResult) {
        return { error: { code: "INVALID_RANGE", message: rangeResult.error } };
      }
      const [dateFrom, dateTo] = rangeResult;
      const rangeLabel = preset ?? `${from} → ${to}`;

      if (metrica === "ventas_periodo") {
        const agg = await queryVentasPeriodo(businessId, dateFrom, dateTo);
        const total = Number(agg._sum.totalAmount ?? 0);
        const count = agg._count.id;
        return {
          period: rangeLabel,
          saleCount: count,
          totalRevenue: total,
          totalRevenueFormatted: fmtCurrency(total, currency),
          message: count === 0
            ? `Sin ventas en ${rangeLabel}.`
            : `${rangeLabel}: ${count} venta(s), total ${fmtCurrency(total, currency)}.`,
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
        const coverageNote = itemsWithCost < items.length
          ? ` (costo en ${itemsWithCost}/${items.length} líneas; resto excluido)`
          : null;
        return {
          period: rangeLabel,
          revenue, revenueFormatted: fmtCurrency(revenue, currency),
          cost, costFormatted: fmtCurrency(cost, currency),
          margin, marginFormatted: fmtCurrency(margin, currency),
          marginPercent: Math.round(marginPct * 10) / 10,
          coverageNote,
          message: items.length === 0
            ? `Sin ventas para calcular margen en ${rangeLabel}.`
            : `${rangeLabel} — Ingresos: ${fmtCurrency(revenue, currency)}, Costo: ${fmtCurrency(cost, currency)}, Margen: ${fmtCurrency(margin, currency)} (${marginPct.toFixed(1)}%)${coverageNote ?? ""}`,
        };
      }

      if (metrica === "ranking_productos") {
        const ranking = await queryRankingProductos(businessId, dateFrom, dateTo, limit);
        if (ranking.length === 0) {
          return { period: rangeLabel, ranking: [], message: `Sin ventas en ${rangeLabel}.` };
        }
        return {
          period: rangeLabel,
          ranking,
          message: `Ranking ${rangeLabel}: #1 ${ranking[0].product} con ${ranking[0].unitsSold} unidades.`,
        };
      }

      if (metrica === "por_empleado") {
        const byEmployee = await queryPorEmpleado(businessId, dateFrom, dateTo);
        if (byEmployee.length === 0) {
          return { period: rangeLabel, byEmployee: [], message: `Sin ventas en ${rangeLabel}.` };
        }
        const formatted = byEmployee.map((e) => ({
          ...e,
          totalRevenueFormatted: fmtCurrency(e.totalRevenue, currency),
        }));
        const lines = formatted
          .map((e) => `${e.employee}: ${e.totalRevenueFormatted} (${e.saleCount} venta${e.saleCount !== 1 ? "s" : ""})`)
          .join(", ");
        return {
          period: rangeLabel,
          byEmployee: formatted,
          message: `${rangeLabel} — Por empleado: ${lines}.`,
        };
      }

      // Exhaustive guard — TypeScript flags missing branches at compile time.
      const _exhaustive: never = metrica;
      return { error: { code: "UNKNOWN_METRIC", message: `Métrica no implementada: ${_exhaustive as string}` } };
    },
  });
}
