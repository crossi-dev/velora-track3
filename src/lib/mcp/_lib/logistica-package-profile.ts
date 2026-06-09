// src/lib/mcp/_lib/logistica-package-profile.ts — Package weight computation helper.
//
// Extracted from logistica-helpers.ts to keep both files under the 300-line contract.
// Used by logistica-helpers.ts (registerPackageProfileTool) via the LogisticaBackend
// seam and also by tests that probe weight logic in isolation.
//
// References:
//   package-profile-tool.ts — src/app/api/agents/logistica/jsonrpc/_lib/logistica-tools/
//   Keep weight-computation logic in sync with the agent-side tool when updating.

import { prisma } from "@/lib/prisma";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PackageProfileResult {
  weightGrams: number;
  hasRealWeightData: boolean;
  itemCount: number;
  breakdown: Array<{ productId: string; quantity: number; weightGrams: number }>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const GRAMS_PER_ITEM_DEFAULT = 500;

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Sums weight across items using per-product weightGrams when available. */
function sumWeightItems(
  items: Array<{ id: string; quantity: number; weightGrams: number | null }>,
): { totalGrams: number; allHaveRealWeight: boolean } {
  let totalGrams = 0;
  let allHaveRealWeight = true;
  for (const item of items) {
    if (item.weightGrams !== null && item.weightGrams > 0) {
      totalGrams += item.quantity * item.weightGrams;
    } else {
      totalGrams += item.quantity * GRAMS_PER_ITEM_DEFAULT;
      allHaveRealWeight = false;
    }
  }
  return { totalGrams, allHaveRealWeight };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Computes the package profile (weight + breakdown) for a shipment.
 * Intentional fork of package-profile-tool.ts from the Logística agent — adds a
 * `breakdown` field; keep both in sync when changing weight-computation logic.
 * Both queries are scoped by the closure businessId for tenant isolation.
 *
 * Priority: weightGramsOverride > saleId > productIds > single-item default.
 */
export async function computePackageProfile(
  args: {
    saleId?: string;
    productIds?: string[];
    weightGramsOverride?: number;
  },
  businessId: string,
): Promise<PackageProfileResult> {
  if (typeof args.weightGramsOverride === "number" && args.weightGramsOverride > 0) {
    return {
      weightGrams: args.weightGramsOverride,
      hasRealWeightData: true,
      itemCount: 1,
      breakdown: [],
    };
  }

  if (args.saleId) {
    try {
      const items = await prisma.saleItem.findMany({
        where: { saleId: args.saleId, sale: { is: { businessId } } },
        select: {
          quantity: true,
          productId: true,
          product: { select: { weightGrams: true } },
        },
      });
      const itemCount = items.reduce((acc, si) => acc + si.quantity, 0);
      // productId can be null per schema (soft-deleted product) — fall back to a placeholder.
      const mapped = items.map((si) => ({
        id: si.productId ?? "unknown",
        quantity: si.quantity,
        weightGrams: si.product?.weightGrams ?? null,
      }));
      const { totalGrams, allHaveRealWeight } = sumWeightItems(mapped);
      const breakdown = mapped.map((si) => ({
        productId: si.id,
        quantity: si.quantity,
        weightGrams:
          si.weightGrams !== null && si.weightGrams > 0
            ? si.quantity * si.weightGrams
            : si.quantity * GRAMS_PER_ITEM_DEFAULT,
      }));
      return { weightGrams: totalGrams, hasRealWeightData: allHaveRealWeight, itemCount, breakdown };
    } catch {
      return { weightGrams: GRAMS_PER_ITEM_DEFAULT, hasRealWeightData: false, itemCount: 1, breakdown: [] };
    }
  }

  if (Array.isArray(args.productIds) && args.productIds.length > 0) {
    try {
      const products = await prisma.product.findMany({
        where: { id: { in: args.productIds }, businessId },
        select: { id: true, weightGrams: true },
      });
      const mapped = args.productIds.map((pid) => {
        const found = products.find((p) => p.id === pid);
        return { id: pid, quantity: 1, weightGrams: found?.weightGrams ?? null };
      });
      const { totalGrams, allHaveRealWeight } = sumWeightItems(mapped);
      const breakdown = mapped.map((item) => ({
        productId: item.id,
        quantity: 1,
        weightGrams:
          item.weightGrams !== null && item.weightGrams > 0
            ? item.weightGrams
            : GRAMS_PER_ITEM_DEFAULT,
      }));
      return {
        weightGrams: totalGrams,
        hasRealWeightData: allHaveRealWeight,
        itemCount: args.productIds.length,
        breakdown,
      };
    } catch {
      return {
        weightGrams: args.productIds.length * GRAMS_PER_ITEM_DEFAULT,
        hasRealWeightData: false,
        itemCount: args.productIds.length,
        breakdown: [],
      };
    }
  }

  return { weightGrams: GRAMS_PER_ITEM_DEFAULT, hasRealWeightData: false, itemCount: 1, breakdown: [] };
}
