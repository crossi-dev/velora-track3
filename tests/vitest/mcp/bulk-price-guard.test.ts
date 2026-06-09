// Unit tests for bulkPriceGuard — the MCP catalog-wipe / absurd-bulk-change guard.
import { describe, it, expect } from "vitest";
import { bulkPriceGuard } from "@/lib/mcp/_lib/bulk-price-guard";

function code(r: ReturnType<typeof bulkPriceGuard>): string | null {
  if (!r) return null;
  const parsed = JSON.parse(r.content[0].text) as { code: string };
  return parsed.code;
}

describe("bulkPriceGuard", () => {
  it("rejects direction=set on the WHOLE catalog (productIds omitted) — catalog-wipe vector", () => {
    const r = bulkPriceGuard({ amount: 1, mode: "fixed", direction: "set" });
    expect(r).not.toBeNull();
    expect(r?.isError).toBe(true);
    expect(code(r)).toBe("BULK_PRICE_GUARD");
  });

  it("rejects direction=set with an empty productIds array", () => {
    expect(code(bulkPriceGuard({ amount: 1, mode: "fixed", direction: "set", productIds: [] }))).toBe("BULK_PRICE_GUARD");
  });

  it("allows direction=set when explicit productIds are targeted", () => {
    expect(bulkPriceGuard({ amount: 999, mode: "fixed", direction: "set", productIds: ["p1", "p2"] })).toBeNull();
  });

  it("rejects a percentage decrease of 100% or more (zero/negative prices)", () => {
    expect(code(bulkPriceGuard({ amount: 100, mode: "percent", direction: "down" }))).toBe("BULK_PRICE_GUARD");
    expect(code(bulkPriceGuard({ amount: 150, mode: "percent", direction: "down" }))).toBe("BULK_PRICE_GUARD");
  });

  it("rejects a percentage change above 200% (hallucination guard)", () => {
    expect(code(bulkPriceGuard({ amount: 9999, mode: "percent", direction: "up" }))).toBe("BULK_PRICE_GUARD");
  });

  it("allows reasonable percentage changes", () => {
    expect(bulkPriceGuard({ amount: 50, mode: "percent", direction: "up" })).toBeNull();
    expect(bulkPriceGuard({ amount: 30, mode: "percent", direction: "down" })).toBeNull();
    expect(bulkPriceGuard({ amount: 200, mode: "percent", direction: "up" })).toBeNull(); // boundary inclusive
  });

  it("allows reasonable whole-catalog fixed changes but caps absurd ones", () => {
    expect(bulkPriceGuard({ amount: 500, mode: "fixed", direction: "up" })).toBeNull();
    expect(bulkPriceGuard({ amount: 100, mode: "fixed", direction: "down" })).toBeNull();
    // whole-catalog fixed change above $1M = hallucination → rejected
    expect(code(bulkPriceGuard({ amount: 9_999_999, mode: "fixed", direction: "up" }))).toBe("BULK_PRICE_GUARD");
    expect(code(bulkPriceGuard({ amount: 5_000_000, mode: "fixed", direction: "down" }))).toBe("BULK_PRICE_GUARD");
  });

  it("trusts targeted (productIds) fixed changes regardless of amount", () => {
    expect(bulkPriceGuard({ amount: 9_999_999, mode: "fixed", direction: "up", productIds: ["p1"] })).toBeNull();
  });
});
