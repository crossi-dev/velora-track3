// src/lib/mcp/_lib/reportes-backend.port.ts — Backend-agnostic port for the reportes MCP tool pack.
//
// Decouples the query_sales tool from its current direct dependency on the
// ADK ventas-reportes-queries module.
// A future TiendaNubeReportesAdapter (or any other backend) implements this
// interface and requires ZERO changes to reportes-tools.ts or the MCP server.
//
// Design mirrors catalog-backend.port.ts:
//   port (this file) → adapter + factory (reportes-backend.factory.ts)
//
// Read-only — no idempotency or audit write needed. tenantId is opaque here;
// the Velora adapter maps it to businessId internally.

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ── query_sales ───────────────────────────────────────────────────────────────

export type QuerySalesMetric =
  | "ventas_periodo"
  | "margen"
  | "ranking_productos"
  | "por_empleado"
  | "historial_cliente";

export interface QuerySalesInput {
  tenantId: string;
  metrica: QuerySalesMetric;
  preset?: "hoy" | "semana" | "mes";
  from?: string;
  to?: string;
  customer_name?: string;
  limit?: number;
}

/**
 * Backend-agnostic reportes port for the MCP reportes tool pack.
 *
 * A single method maps to the query_sales MCP tool.
 * Returns CallToolResult so reportes-tools.ts can forward the result directly
 * to the MCP framework without any translation.
 *
 * Tenant isolation is enforced by each adapter via tenantId on the input.
 * Throws or returns isError:true for error paths — reportes-tools.ts forwards both.
 */
export interface ReportesBackend {
  querySales(input: QuerySalesInput): Promise<CallToolResult>;
}
