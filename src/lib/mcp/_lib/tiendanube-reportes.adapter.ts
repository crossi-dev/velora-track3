// src/lib/mcp/_lib/tiendanube-reportes.adapter.ts — Tiendanube ReportesBackend adapter.
//
// Implements the ReportesBackend port against the Tiendanube REST API so that
// query_sales aggregates real Tiendanube order data instead of Velora DB records.
//
// HTTP client, credential loading, and shared helpers live in tiendanube-ventas.client.ts.
//
// METRIC MAPPING DECISIONS:
//   - ventas_periodo: GET /orders with created_at_min/created_at_max filters → count + total.
//   - margen: TN has no cost-price on orders. Revenue is computed from order totals;
//     cost is always null. marginPercent = null, and a clear note is returned.
//   - ranking_productos: fetches orders in range, flattens line items, aggregates by variant name.
//   - por_empleado: TN has no employee concept. Returns errResponse "not supported on TN".
//   - historial_cliente: GET /orders with customer filter → lifetime + recent orders.
//
// DATE HANDLING:
//   TN uses ISO 8601 UTC timestamps for created_at_min/max.
//   Input dates are YYYY-MM-DD; we append T00:00:00Z / T23:59:59Z for full-day coverage.
//
// Source: tiendanube.github.io/api-documentation (verified 2026-06-08).

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ReportesBackend, QuerySalesInput } from "./reportes-backend.port";
import { errResponse } from "./mcp-responses";
import { fmtCurrency } from "@/lib/adk/tools/_lib/ventas-reportes-queries";
import {
  loadTiendanubeCredentials,
  tiendanubeBaseUrl,
  tiendanubeRequest,
  type TiendanubeOrder,
} from "./tiendanube-ventas.client";

const DEFAULT_CURRENCY = "ARS"; // matches Velora reportes adapter

// ── Date helpers ──────────────────────────────────────────────────────────────

function toIsoStart(date: string): string {
  return `${date}T00:00:00Z`;
}
function toIsoEnd(date: string): string {
  return `${date}T23:59:59Z`;
}

function resolveRange(
  preset: QuerySalesInput["preset"],
  from: string | undefined,
  to: string | undefined,
): { dateFrom: string; dateTo: string } | null {
  const now = new Date();
  const toDate = (d: Date) => d.toISOString().slice(0, 10);

  if (preset === "hoy") {
    const today = toDate(now);
    return { dateFrom: today, dateTo: today };
  }
  if (preset === "semana") {
    const monday = new Date(now);
    monday.setDate(now.getDate() - now.getDay() + 1);
    return { dateFrom: toDate(monday), dateTo: toDate(now) };
  }
  if (preset === "mes") {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { dateFrom: toDate(first), dateTo: toDate(now) };
  }
  if (from && to) return { dateFrom: from, dateTo: to };
  return null;
}

// ── Paginated order fetcher (with date filter) ────────────────────────────────

async function fetchOrdersInRange(
  storeId: string,
  token: string,
  dateFrom: string,
  dateTo: string,
  perPage = 200,
): Promise<TiendanubeOrder[]> {
  const baseUrl = tiendanubeBaseUrl(storeId, "orders");
  const params = new URLSearchParams({
    created_at_min: toIsoStart(dateFrom),
    created_at_max: toIsoEnd(dateTo),
    per_page: String(perPage),
    page: "1",
  });

  const all: TiendanubeOrder[] = [];
  let page = 1;
  const MAX_PAGES = 20;

  while (page <= MAX_PAGES) {
    params.set("page", String(page));
    const url = `${baseUrl}?${params.toString()}`;
    const batch = await tiendanubeRequest<TiendanubeOrder[]>(url, token);
    all.push(...batch);
    if (batch.length < perPage) break;
    page++;
  }
  return all;
}

// ── Credential guard ──────────────────────────────────────────────────────────

async function requireCredentials(tenantId: string) {
  const credentials = await loadTiendanubeCredentials(tenantId);
  if (!credentials) {
    return errResponse(
      "TIENDANUBE_NOT_CONNECTED",
      "No Tiendanube credentials found for this business. " +
        "Connect via BusinessChannelCredential with provider='tiendanube'.",
    );
  }
  return credentials;
}

// ── Adapter ────────────────────────────────────────────────────────────────────

/**
 * Tiendanube ReportesBackend adapter.
 *
 * Credential setup (one-time per tenant):
 *   encryptCredential(JSON.stringify({ accessToken: "<token>", storeId: "<numericId>" }))
 *   → insert BusinessChannelCredential { businessId, provider: "tiendanube", encryptedCredentials }
 *   → set TenantToolConfig.reportes = "tiendanube"
 */
export class TiendanubeReportesAdapter implements ReportesBackend {
  async querySales(input: QuerySalesInput): Promise<CallToolResult> {
    const { tenantId, metrica, preset, from, to, limit = 10 } = input;
    const credsOrErr = await requireCredentials(tenantId);
    if ("isError" in credsOrErr) return credsOrErr;
    const credentials = credsOrErr;

    // ── historial_cliente ─────────────────────────────────────────────────────
    if (metrica === "historial_cliente") {
      const rawName = input.customer_name?.trim();
      if (!rawName) {
        return errResponse("MISSING_PARAM", "customer_name is required for historial_cliente.");
      }

      // Search customers by name
      const custUrl =
        `${tiendanubeBaseUrl(credentials.storeId, "customers")}` +
        `?q=${encodeURIComponent(rawName)}&per_page=10`;
      const customers = await tiendanubeRequest<Array<{ id: number; name: string; email: string | null }>>(
        custUrl, credentials.accessToken,
      );

      if (customers.length === 0) {
        return errResponse("NOT_FOUND", `Customer "${rawName}" not found on Tiendanube.`);
      }
      if (customers.length > 1) {
        return errResponse(
          "AMBIGUOUS",
          `Multiple customers found: ${customers.map((c) => c.name).join(", ")}. Provide the exact name.`,
        );
      }
      const customer = customers[0]!;

      // Fetch all orders for this customer
      const ordersUrl =
        `${tiendanubeBaseUrl(credentials.storeId, "orders")}` +
        `?customer_id=${customer.id}&per_page=200`;
      const allOrders = await tiendanubeRequest<TiendanubeOrder[]>(ordersUrl, credentials.accessToken);

      const lifetimeTotalSpent = allOrders.reduce((sum, o) => sum + parseFloat(o.total), 0);
      const recentOrders = allOrders
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, limit)
        .map((o) => ({
          orderId: String(o.id),
          orderNumber: o.number,
          total: parseFloat(o.total),
          status: o.status,
          createdAt: o.created_at,
        }));

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            customer: { id: String(customer.id), name: customer.name, email: customer.email },
            lifetimeOrderCount: allOrders.length,
            lifetimeTotalSpent,
            recentOrdersScope: `last ${limit}`,
            recentOrders,
            backend: "tiendanube",
          }),
        }],
      };
    }

    // All other metrics require a date range
    const range = resolveRange(preset, from, to);
    if (!range) {
      return errResponse(
        "INVALID_RANGE",
        "Supply both 'from' and 'to' (YYYY-MM-DD), or a preset: hoy|semana|mes.",
      );
    }
    const { dateFrom, dateTo } = range;
    const rangeLabel = preset ?? `${from} → ${to}`;

    // ── por_empleado ──────────────────────────────────────────────────────────
    // TN has no employee concept — honest unsupported response.
    if (metrica === "por_empleado") {
      return errResponse(
        "TIENDANUBE_NOT_SUPPORTED",
        "por_empleado is not supported on Tiendanube. " +
          "Tiendanube orders have no employee/staff attribution. " +
          "Use the Velora backend for employee-level sales reporting.",
      );
    }

    // Fetch orders for the date range (shared by all remaining metrics)
    const orders = await fetchOrdersInRange(
      credentials.storeId, credentials.accessToken, dateFrom, dateTo,
    );

    // ── ventas_periodo ────────────────────────────────────────────────────────
    if (metrica === "ventas_periodo") {
      const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.total), 0);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            period: rangeLabel,
            saleCount: orders.length,
            totalRevenue,
            totalRevenueFormatted: fmtCurrency(totalRevenue, DEFAULT_CURRENCY),
            backend: "tiendanube",
          }),
        }],
      };
    }

    // ── margen ────────────────────────────────────────────────────────────────
    // TN does not store cost prices on orders. Revenue is computable; margin is not.
    if (metrica === "margen") {
      const revenue = orders.reduce((sum, o) => sum + parseFloat(o.total), 0);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            period: rangeLabel,
            revenue,
            revenueFormatted: fmtCurrency(revenue, DEFAULT_CURRENCY),
            cost: null,
            margin: null,
            marginPercent: null,
            note:
              "Tiendanube does not store cost prices on orders. " +
              "Revenue is available; margin cannot be computed. " +
              "Use the Velora backend for margin reporting.",
            backend: "tiendanube",
          }),
        }],
      };
    }

    // ── ranking_productos ─────────────────────────────────────────────────────
    if (metrica === "ranking_productos") {
      const aggregated = new Map<string, { name: string; qty: number; revenue: number }>();
      for (const o of orders) {
        for (const item of o.products) {
          const key = String(item.variant_id);
          const itemName = item.name.es ?? item.name.en ?? item.name.pt ?? `Variant ${key}`;
          const existing = aggregated.get(key);
          const qty = item.quantity;
          const revenue = qty * parseFloat(item.price);
          if (existing) {
            existing.qty += qty;
            existing.revenue += revenue;
          } else {
            aggregated.set(key, { name: itemName, qty, revenue });
          }
        }
      }

      const ranking = Array.from(aggregated.entries())
        .map(([variantId, data]) => ({
          variantId,
          name: data.name,
          totalQuantity: data.qty,
          totalRevenue: data.revenue,
        }))
        .sort((a, b) => b.totalRevenue - a.totalRevenue)
        .slice(0, limit);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ period: rangeLabel, ranking, backend: "tiendanube" }),
        }],
      };
    }

    // Exhaustive guard — TypeScript flags missing branches at compile time.
    const _exhaustive: never = metrica;
    return errResponse("UNKNOWN_METRIC", `Metric not implemented: ${_exhaustive as string}`);
  }
}
