// tests/vitest/adk/business-query-tool.test.ts
//
// Unit tests for business_query FunctionTool after the Merge-1 + Merge-2 refactor:
//   - sales_summary kind removed: not in schema enum, returns fallback if passed
//   - cleanupProductName folded into kind=stock: stopword-prefixed names resolve correctly
//   - kind=inventory_summary: delegates to buildInventorySummaryAnswer unchanged
//
// Calls tool.execute() directly (no ADK runner) — same pattern as owner-list-tools.test.ts.
// No Prisma mocks needed: business_query is purely in-memory (closure context).

import { describe, it, expect } from "vitest";
import { createBusinessQueryTool } from "@/lib/adk/tools/business-query-tool";
import type { BusinessQueryToolContext } from "@/lib/adk/tools/business-query-tool";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Calls a FunctionTool's execute function directly (bypasses ADK runner). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal ADK property access, same pattern as owner-list-tools.test.ts
async function exec(tool: ReturnType<typeof createBusinessQueryTool>, args: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- internal ADK property
  return (tool as any).execute(args);
}

function makeCtx(overrides?: Partial<BusinessQueryToolContext>): BusinessQueryToolContext {
  return {
    productDirectory: [
      { id: "p1", name: "Gaseosa Cola", price: 150, stock: 10, sku: null },
      { id: "p2", name: "Agua Mineral", price: 80, stock: 5, sku: null },
    ],
    context: {
      business: { name: "Test Business", currency: "ARS" },
      inventorySummary: { productLines: 2, totalUnits: 15, totalValue: 1900 },
      recentSales: [],
    } as unknown as BusinessQueryToolContext["context"],
    locale: "es-AR",
    business: { name: "Test Business", currency: "ARS" },
    inventorySummary: { productLines: 2, totalUnits: 15, totalValue: 1900 },
    ...overrides,
  };
}

// ── sales_summary removed ─────────────────────────────────────────────────────

describe("business_query — sales_summary removed", () => {
  it("returns fallback when kind=sales_summary is passed (backward-compat: treated as unknown kind)", async () => {
    const tool = createBusinessQueryTool(makeCtx());
    // sales_summary is no longer a recognised kind — execute falls through to fallback
    const result = await exec(tool, { query: "cómo van las ventas?", kind: "sales_summary" }) as {
      answer: unknown;
      fallback?: boolean;
    };
    // Must not throw, must not return a sales total (the branch is gone)
    expect(result.fallback).toBe(true);
    expect(result.answer).toBeNull();
  });

  it("schema enum does not include sales_summary", () => {
    // Verify the enum on the FunctionTool's parameter schema
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tool = createBusinessQueryTool(makeCtx()) as any;
    const kindEnum: string[] = tool.parameters?.properties?.kind?.enum ?? [];
    expect(kindEnum).not.toContain("sales_summary");
    // The remaining valid kinds must still be present
    expect(kindEnum).toContain("stock");
    expect(kindEnum).toContain("price");
    expect(kindEnum).toContain("inventory_summary");
    expect(kindEnum).toContain("general");
  });
});

// ── cleanupProductName folded into kind=stock ─────────────────────────────────

describe("business_query — kind=stock with stopword cleanup (Merge-2 fold)", () => {
  it("resolves stock when product_name has a leading Rioplatense stopword 'decime'", async () => {
    const tool = createBusinessQueryTool(makeCtx());
    const result = await exec(tool, {
      query: "decime stock de gaseosa cola",
      kind: "stock",
      product_name: "decime gaseosa cola",
    }) as { answer: string; found?: boolean };
    // cleanupProductName strips "decime " → "gaseosa cola" → matches "Gaseosa Cola"
    expect(result.found).toBe(true);
    expect(result.answer).toContain("Gaseosa Cola");
  });

  it("resolves stock when product_name has a leading stopword 'mostrame'", async () => {
    const tool = createBusinessQueryTool(makeCtx());
    const result = await exec(tool, {
      query: "mostrame el stock del agua",
      kind: "stock",
      product_name: "mostrame agua mineral",
    }) as { answer: string; found?: boolean };
    expect(result.found).toBe(true);
    expect(result.answer).toContain("Agua Mineral");
  });

  it("resolves stock for a clean product name without stopwords", async () => {
    const tool = createBusinessQueryTool(makeCtx());
    const result = await exec(tool, {
      query: "cuánto stock de gaseosa?",
      kind: "stock",
      product_name: "gaseosa cola",
    }) as { answer: string; found?: boolean };
    expect(result.found).toBe(true);
    expect(result.answer).toContain("Gaseosa Cola");
  });

  it("returns found=false for a product that does not exist", async () => {
    const tool = createBusinessQueryTool(makeCtx());
    const result = await exec(tool, {
      query: "tengo stock de cosas?",
      kind: "stock",
      product_name: "producto inexistente xyz",
    }) as { answer: string; found?: boolean };
    expect(result.found).toBe(false);
    expect(result.answer).toContain("No encontré");
  });
});

// ── inventory_summary unchanged ───────────────────────────────────────────────

describe("business_query — kind=inventory_summary", () => {
  it("returns an inventory summary answer", async () => {
    const tool = createBusinessQueryTool(makeCtx());
    const result = await exec(tool, {
      query: "cómo está el inventario?",
      kind: "inventory_summary",
    }) as { answer: string };
    expect(typeof result.answer).toBe("string");
    expect(result.answer.length).toBeGreaterThan(0);
  });
});
