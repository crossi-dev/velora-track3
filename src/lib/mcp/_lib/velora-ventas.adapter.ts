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

export class VeloraVentasAdapter implements VentasBackend {
  async queryCatalog(input: QueryCatalogInput): Promise<CatalogProductResult[]> {
    const { tenantId: businessId, search } = input;
    return queryCatalog(businessId, search);
  }

  async getLowStockProducts(input: GetLowStockProductsInput): Promise<LowStockProductResult[]> {
    const { tenantId: businessId } = input;
    // Exact query moved from stock-consultar-tool.ts (filter=low_stock branch).
    // in-memory snapshot does not carry reorderThreshold — DB read required.
    const rows = await prisma.product.findMany({
      where: { businessId },
      select: { id: true, name: true, quantity: true, reorderThreshold: true },
      orderBy: { name: "asc" },
    });
    return rows
      .filter((p) => p.quantity <= p.reorderThreshold)
      .map((p) => ({ id: p.id, name: p.name, stock: p.quantity, reorderThreshold: p.reorderThreshold }));
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
