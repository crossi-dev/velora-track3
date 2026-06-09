import "server-only";
// src/lib/mcp/reportes-tools.ts — Stateful sales reporting MCP tool registration.
//
// Registers one tenant-scoped read-only tool on a McpServer instance:
//   - query_sales : sales metrics via a `metrica` discriminant, mirroring
//                   the ADK ventas.consultar_ventas tool.
//
// Five metrics available via the metrica field:
//   ventas_periodo    — revenue + count for a date range
//   margen            — gross margin (revenue − cost using SaleItem.unitCost)
//   ranking_productos — best-sellers by units sold
//   por_empleado      — revenue breakdown per employee
//   historial_cliente — recent orders for a named customer
//
// Read-only — no idempotency or audit write needed.
//
// Query functions are imported directly from the ADK layer without duplication:
//   src/lib/adk/tools/_lib/ventas-reportes-queries.ts
//
// businessId ALWAYS comes from the auth-gate closure — never from tool input.
// Tenant isolation: all query functions accept businessId and scope every
// Prisma query to that tenant (same contract as the ADK tool).
//
// References:
//   ADK tool   — src/lib/adk/tools/ventas-reportes-tool.ts
//   Query fns  — src/lib/adk/tools/_lib/ventas-reportes-queries.ts
//   Square SearchOrders pattern — https://developer.squareup.com/reference/square/orders-api/search-orders

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ReportesBackend } from "./_lib/reportes-backend.port";

// ── Registration helper ───────────────────────────────────────────────────────

/**
 * Registers query_sales on the given McpServer.
 * Called only when a verified businessId is available from the auth gate.
 * Read-only — backend is injected via createReportesBackend(map.reportes).
 */
export function registerReportesTools(
  server: McpServer,
  businessId: string,
  backend: ReportesBackend,
): void {
  server.registerTool(
    "query_sales",
    {
      title: "Query sales",
      description:
        "Queries sales metrics from the database for the authenticated business. " +
        "Use metrica to select the report type: " +
        "'ventas_periodo' = total revenue + count for a period; " +
        "'margen' = gross margin (revenue minus historical cost); note: costCoverage in the " +
        "response shows how many lines have cost data — margin is understated when coverage<100%; " +
        "'ranking_productos' = best-sellers by units sold; " +
        "'por_empleado' = revenue breakdown per employee; " +
        "'historial_cliente' = purchase history for a named customer. " +
        "Date range: supply preset ('hoy'|'semana'|'mes') OR from+to (YYYY-MM-DD). " +
        "historial_cliente requires customer_name but does not require a date range. " +
        "Use this to get real sales figures; do not estimate or invent revenue numbers.",
      inputSchema: {
        metrica: z
          .enum(["ventas_periodo", "margen", "ranking_productos", "por_empleado", "historial_cliente"])
          .describe("Metric to query."),
        preset: z
          .enum(["hoy", "semana", "mes"])
          .optional()
          .describe("Preset date range. Mutually exclusive with from/to."),
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Start date YYYY-MM-DD. Requires 'to'."),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("End date YYYY-MM-DD. Requires 'from'."),
        customer_name: z
          .string()
          .min(1)
          .optional()
          .describe("Customer name or fragment. Only for historial_cliente."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Max results for ranking/historial (default 10, max 50)."),
      },
      // Spec ToolAnnotations: https://modelcontextprotocol.io/specification/2025-06-18/schema
      annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    },
    (args) => backend.querySales({ tenantId: businessId, ...args }),
  );
}
