// src/lib/mcp/_lib/ventas-queries.ts — Read-only product/stock queries for Ventas MCP tools.
//
// One function:
//   queryCatalog  — list active products for a business, optional name search, limit 50.
//                   Each product row includes its stock quantity.
//
// Scopes by businessId. Does not perform any write.
// Reuses buildActiveProductWhere from product-sku infra (same filter the dashboard uses)
// and the same prisma.product.findMany select used by fetchProducts in _get.ts.
//
// References:
//   buildActiveProductWhere — src/infrastructure/shared/product-sku.ts
//   fetchProducts pattern   — src/app/api/products/_get.ts

import { prisma } from "@/lib/prisma";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";

export interface CatalogProduct {
  id: string;
  name: string;
  price: number;
  costPrice: number | null;
  sku: string | null;
  stock: number;
  weightGrams: number | null;
}

const CATALOG_LIMIT = 50;

/**
 * Returns up to 50 active products for the business, sorted by name.
 * When search is provided, filters to products whose name contains the
 * search string (case-insensitive, Prisma insensitive mode).
 * Scoped by businessId — never returns rows from other tenants.
 */
export async function queryCatalog(
  businessId: string,
  search?: string,
): Promise<CatalogProduct[]> {
  const baseWhere = search
    ? { businessId, name: { contains: search, mode: "insensitive" as const } }
    : { businessId };

  // tenant-scope-ok: baseWhere always includes businessId; passed via buildActiveProductWhere.
  const rows = await prisma.product.findMany({
    where: buildActiveProductWhere(baseWhere),
    select: {
      id: true,
      name: true,
      price: true,
      costPrice: true,
      sku: true,
      quantity: true,
      weightGrams: true,
    },
    orderBy: { name: "asc" },
    take: CATALOG_LIMIT,
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    price: Number(r.price),
    costPrice: r.costPrice != null ? Number(r.costPrice) : null,
    sku: r.sku,
    stock: r.quantity,
    weightGrams: r.weightGrams ?? null,
  }));
}

