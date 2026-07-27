// src/lib/mcp/_lib/velora-ventas.adapter.ts — Velora concrete implementation of VentasBackend.
//
// Wraps the existing query functions from ventas-queries.ts.
// Pure restructure — zero behavioral change. tenantId is mapped to businessId
// before every query call.
//
// Design source: velora-catalog.adapter.ts (composition over inheritance).
// The adapter is a thin delegation layer: it doesn't add logic, it translates shapes.

import type {
  VentasBackend,
  QueryCatalogInput,
  CatalogProductResult,
  GetLowStockProductsInput,
  LowStockProductResult,
  GetProductStockInput,
  ProductStockResult,
} from "./ventas-backend.port";
import { queryCatalog } from "./ventas-queries";
import { prisma } from "@/lib/prisma";

type LowStockRow = { id: string; name: string; quantity: number; reorderThreshold: number };

export class VeloraVentasAdapter implements VentasBackend {
  async queryCatalog(input: QueryCatalogInput): Promise<CatalogProductResult[]> {
    const { tenantId: businessId, search } = input;
    return queryCatalog(businessId, search);
  }

  async getLowStockProducts(input: GetLowStockProductsInput): Promise<LowStockProductResult[]> {
    const { tenantId: businessId } = input;
    // Originally: findMany the WHOLE catalog, then filter quantity<=reorderThreshold
    // in memory — Prisma's query API can't express a cross-column comparison
    // (quantity vs. reorderThreshold, both columns on the same row) without a raw
    // query. Fixed to filter in Postgres instead: same $queryRaw pattern already
    // used for this exact comparison in src/app/api/scheduled/low-stock-alert/route.ts.
    // Filter semantics unchanged from the original in-memory version (<=, no
    // reorderThreshold>0 exclusion) — only the unbounded-fetch cost is fixed.
    const rows = await prisma.$queryRaw<LowStockRow[]>`
      SELECT "id", "name", "quantity", "reorderThreshold"
      FROM "Product"
      WHERE "businessId" = ${businessId}
        AND "quantity" <= "reorderThreshold"
      ORDER BY "name" ASC
    `;
    return rows.map((p) => ({ id: p.id, name: p.name, stock: p.quantity, reorderThreshold: p.reorderThreshold }));
  }

  async getProductStock(input: GetProductStockInput): Promise<ProductStockResult | null> {
    const { tenantId: businessId, productId } = input;
    // Exact query moved from stock-gestionar-tool.ts (action=stocktake branch).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma DLL lock on Windows
    const row = await (prisma as any).product.findFirst({
      where: { id: productId, businessId },
      select: { quantity: true },
    }) as { quantity: number } | null;
    if (!row) return null;
    return { quantity: row.quantity };
  }
}
