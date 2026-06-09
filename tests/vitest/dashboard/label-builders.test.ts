import { describe, expect, it } from "vitest";
import { buildPriceOutlierLabel } from "@/app/dashboard/lib/price-outlier-label";
import { buildStockShortfallLabel } from "@/app/dashboard/lib/stock-shortfall-label";

// In Node (Vitest), typeof window === "undefined" → tLang always returns the Spanish (es) string.

describe("buildPriceOutlierLabel", () => {
  it("includes up-arrow for 'above' direction", () => {
    const label = buildPriceOutlierLabel({ direction: "above", expected: 100 }, "ARS");
    expect(label).toContain("↑");
  });
  it("includes down-arrow for 'below' direction", () => {
    const label = buildPriceOutlierLabel({ direction: "below", expected: 50 }, "ARS");
    expect(label).toContain("↓");
  });
  it("includes warning prefix ⚠", () => {
    const label = buildPriceOutlierLabel({ direction: "above", expected: 100 }, "ARS");
    expect(label).toContain("⚠");
  });
  it("includes 'catálogo' in Spanish output", () => {
    const label = buildPriceOutlierLabel({ direction: "above", expected: 100 }, "ARS");
    expect(label).toContain("catálogo");
  });
  it("includes the formatted expected value in the label", () => {
    const label = buildPriceOutlierLabel({ direction: "above", expected: 100 }, "ARS");
    expect(label).toContain("100");
  });
  it("works with empty currency string (defaults to ARS)", () => {
    const label = buildPriceOutlierLabel({ direction: "below", expected: 200 }, "");
    expect(label).toContain("↓");
    expect(label).toContain("200");
  });
  it("above and below labels differ only in arrow direction", () => {
    const above = buildPriceOutlierLabel({ direction: "above", expected: 100 }, "ARS");
    const below = buildPriceOutlierLabel({ direction: "below", expected: 100 }, "ARS");
    expect(above).not.toBe(below);
    expect(above).toContain("↑");
    expect(below).toContain("↓");
  });
});

describe("buildStockShortfallLabel", () => {
  it("shows out-of-stock message when available = 0", () => {
    const label = buildStockShortfallLabel({ available: 0, requested: 5 });
    expect(label).toContain("Sin stock");
  });
  it("includes requested count in out-of-stock message", () => {
    const label = buildStockShortfallLabel({ available: 0, requested: 7 });
    expect(label).toContain("7");
  });
  it("shows low-stock message when available > 0", () => {
    const label = buildStockShortfallLabel({ available: 2, requested: 5 });
    expect(label).toContain("Stock bajo");
  });
  it("includes available count in low-stock message", () => {
    const label = buildStockShortfallLabel({ available: 3, requested: 5 });
    expect(label).toContain("3");
  });
  it("uses singular 'unidad' when available = 1", () => {
    const label = buildStockShortfallLabel({ available: 1, requested: 3 });
    expect(label).toContain("unidad");
    expect(label).not.toContain("unidades");
  });
  it("uses plural 'unidades' when available > 1", () => {
    const label = buildStockShortfallLabel({ available: 3, requested: 5 });
    expect(label).toContain("unidades");
  });
  it("includes warning prefix ⚠", () => {
    const label = buildStockShortfallLabel({ available: 0, requested: 1 });
    expect(label).toContain("⚠");
  });
});
