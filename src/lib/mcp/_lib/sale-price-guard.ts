// src/lib/mcp/_lib/sale-price-guard.ts — Catalog price resolution + MCP money-path guard.
//
// MONEY-PATH PRICE GUARD (MCP surface — register_sale owner path):
//   unitPrice is OPTIONAL on the MCP tool input. When omitted, the catalog price
//   from the DB is used (NABAOS invariant: monetary values from DB rows, not LLM).
//   When supplied, it is validated against the catalog price via detectPriceOutlier
//   (DEFAULT_PRICE_OUTLIER_THRESHOLD = 50%). Deviations beyond 50% are REJECTED
//   with PRICE_OUTLIER — unlike the owner chat path (which soft-warns and uses a
//   confirmation modal), the MCP surface has no human confirmation step, so the
//   guard must be hard.
//
// Mirror pattern: register-promesa-sale-use-case.ts unitPriceOverride guard.
// NABAOS reference: arXiv 2603.10060, M2 — monetary values must come from DB rows.

import { detectPriceOutlier, DEFAULT_PRICE_OUTLIER_THRESHOLD } from "@/domain/rules";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

export interface ResolvedSaleItem {
  productId: string;
  quantity: number;
  unitPrice: number;
}

export type CatalogResolutionResult =
  | { ok: true; items: ResolvedSaleItem[] }
  | { ok: false; code: "PRODUCT_NOT_OWNED"; productId: string }
  | {
      ok: false;
      code: "PRICE_OUTLIER";
      productId: string;
      productName: string;
      catalogPrice: number;
      suppliedPrice: number;
      direction: "above" | "below";
    }
  | { ok: false; code: "CATALOG_PRICE_INVALID"; productId: string; productName: string };

/**
 * Resolves catalog prices for all items in a register_sale MCP call.
 *
 * Per-item logic:
 *   - unitPrice omitted → use DB catalog price (safe default).
 *   - unitPrice supplied → validate against catalog via detectPriceOutlier;
 *     reject with PRICE_OUTLIER if deviation exceeds DEFAULT_PRICE_OUTLIER_THRESHOLD (50%).
 *
 * Returns PRODUCT_NOT_OWNED on the first productId not found in this tenant.
 * All DB lookups are tenant-scoped by businessId.
 */
export async function resolveCatalogPrices(
  businessId: string,
  items: Array<{ productId: string; quantity: number; unitPrice?: number }>,
): Promise<CatalogResolutionResult> {
  const productIds = [...new Set(items.map((i) => i.productId))];

  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, businessId },
    select: { id: true, name: true, price: true },
  });
  const productMap = new Map(products.map((p) => [p.id, { name: p.name, price: Number(p.price) }]));

  const resolved: ResolvedSaleItem[] = [];
  for (const item of items) {
    const catalogProduct = productMap.get(item.productId);
    if (!catalogProduct) {
      return { ok: false, code: "PRODUCT_NOT_OWNED", productId: item.productId };
    }

    const catalogPrice = catalogProduct.price;
    // A product with no valid catalog price (0/negative/NaN) would make the outlier
    // check a no-op (any supplied price passes) AND produce a zero-total sale when
    // unitPrice is omitted (the MCP path doesn't call validateSaleTotal). Reject hard.
    if (!(catalogPrice > 0)) {
      return { ok: false, code: "CATALOG_PRICE_INVALID", productId: item.productId, productName: catalogProduct.name };
    }
    const suppliedPrice =
      typeof item.unitPrice === "number" && Number.isFinite(item.unitPrice) && item.unitPrice > 0
        ? item.unitPrice
        : undefined;

    if (suppliedPrice !== undefined) {
      const outlier = detectPriceOutlier(suppliedPrice, catalogPrice, DEFAULT_PRICE_OUTLIER_THRESHOLD);
      if (outlier) {
        cloudLog({
          severity: "WARNING",
          component: "SaleExecutor",
          action: "MCP_REGISTER_SALE_PRICE_OUTLIER",
          a2a_transfer: false,
          message:
            "register_sale (MCP): supplied unitPrice deviates from catalog beyond threshold — rejected (NABAOS M2)",
          businessId,
          data: {
            productId: item.productId,
            productName: catalogProduct.name,
            suppliedPrice,
            catalogPrice,
            direction: outlier.direction,
            thresholdPct: Math.round(DEFAULT_PRICE_OUTLIER_THRESHOLD * 100),
          },
        });
        return {
          ok: false,
          code: "PRICE_OUTLIER",
          productId: item.productId,
          productName: catalogProduct.name,
          catalogPrice,
          suppliedPrice,
          direction: outlier.direction,
        };
      }
      resolved.push({ productId: item.productId, quantity: item.quantity, unitPrice: suppliedPrice });
    } else {
      // unitPrice omitted → use catalog price (NABAOS default).
      resolved.push({ productId: item.productId, quantity: item.quantity, unitPrice: catalogPrice });
    }
  }

  return { ok: true, items: resolved };
}
