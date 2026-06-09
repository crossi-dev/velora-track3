import { describe, expect, it } from "vitest";
import {
  ARCHIVED_PRODUCT_SKU_PREFIX,
  normalizeSkuBase,
  buildUniqueSku,
  normalizeProvidedSku,
  normalizeSkuLookup,
  isArchivedProductSku,
  buildArchivedProductSku,
  isProductSkuCollision,
} from "@/infrastructure/shared/product-sku";

describe("normalizeSkuBase", () => {
  it("uppercases and replaces spaces with hyphens", () => {
    expect(normalizeSkuBase("coca cola")).toBe("COCA-COLA");
  });
  it("strips Spanish diacritics", () => {
    expect(normalizeSkuBase("café")).toBe("CAFE");
  });
  it("strips ñ", () => {
    expect(normalizeSkuBase("niño")).toBe("NINO");
  });
  it("replaces special chars with hyphens and collapses them", () => {
    expect(normalizeSkuBase("product (v2)")).toBe("PRODUCT-V2");
  });
  it("truncates at 14 characters", () => {
    const result = normalizeSkuBase("abcdefghijklmnopqrstuvwxyz");
    expect(result.length).toBeLessThanOrEqual(14);
  });
  it("returns ITEM for empty string", () => {
    expect(normalizeSkuBase("")).toBe("ITEM");
  });
  it("returns ITEM for whitespace-only", () => {
    expect(normalizeSkuBase("   ")).toBe("ITEM");
  });
  it("strips leading and trailing hyphens", () => {
    expect(normalizeSkuBase("-hello-")).toBe("HELLO");
  });
  it("collapses multiple consecutive separators to one hyphen", () => {
    expect(normalizeSkuBase("a  b")).toBe("A-B");
  });
});

describe("buildUniqueSku", () => {
  it("returns base when not in usedSkus", () => {
    expect(buildUniqueSku("ITEM", new Set())).toBe("ITEM");
  });
  it("appends -01 on first collision", () => {
    expect(buildUniqueSku("ITEM", new Set(["ITEM"]))).toBe("ITEM-01");
  });
  it("appends -02 on second collision", () => {
    expect(buildUniqueSku("ITEM", new Set(["ITEM", "ITEM-01"]))).toBe("ITEM-02");
  });
  it("adds the returned SKU to the usedSkus set", () => {
    const used = new Set<string>();
    const result = buildUniqueSku("ITEM", used);
    expect(used.has(result)).toBe(true);
  });
  it("pads counter to two digits", () => {
    const used = new Set(Array.from({ length: 9 }, (_, i) => (i === 0 ? "BASE" : `BASE-0${i}`)));
    const result = buildUniqueSku("BASE", used);
    expect(result).toBe("BASE-09");
  });
});

describe("normalizeProvidedSku", () => {
  it("returns null for null", () => expect(normalizeProvidedSku(null)).toBeNull());
  it("returns null for undefined", () => expect(normalizeProvidedSku(undefined)).toBeNull());
  it("returns null for empty string", () => expect(normalizeProvidedSku("")).toBeNull());
  it("returns null for whitespace-only", () => expect(normalizeProvidedSku("   ")).toBeNull());
  it("trims and uppercases string value", () => expect(normalizeProvidedSku("  abc  ")).toBe("ABC"));
  it("coerces number to uppercase string", () => expect(normalizeProvidedSku(123)).toBe("123"));
});

describe("normalizeSkuLookup", () => {
  it("uppercases and strips non-alphanumeric", () => {
    expect(normalizeSkuLookup("abc-123")).toBe("ABC123");
  });
  it("strips diacritics", () => {
    expect(normalizeSkuLookup("café")).toBe("CAFE");
  });
  it("returns empty for null", () => {
    expect(normalizeSkuLookup(null)).toBe("");
  });
  it("returns empty for undefined", () => {
    expect(normalizeSkuLookup(undefined)).toBe("");
  });
  it("trims whitespace then strips", () => {
    expect(normalizeSkuLookup("  abc def  ")).toBe("ABCDEF");
  });
});

describe("isArchivedProductSku", () => {
  it("returns true for a value with the archived prefix", () => {
    expect(isArchivedProductSku(`${ARCHIVED_PRODUCT_SKU_PREFIX}ITEM`)).toBe(true);
  });
  it("returns false for a normal SKU", () => {
    expect(isArchivedProductSku("ITEM-01")).toBe(false);
  });
  it("returns false for null", () => {
    expect(isArchivedProductSku(null)).toBe(false);
  });
  it("returns false for empty string", () => {
    expect(isArchivedProductSku("")).toBe(false);
  });
});

describe("buildArchivedProductSku", () => {
  it("prepends the archived prefix", () => {
    expect(buildArchivedProductSku("abc123def456")).toContain(ARCHIVED_PRODUCT_SKU_PREFIX);
  });
  it("normalizes the product ID (strips hyphens, uppercases)", () => {
    expect(buildArchivedProductSku("abc-123")).toBe(`${ARCHIVED_PRODUCT_SKU_PREFIX}ABC123`);
  });
  it("uses PRODUCTO fallback for empty productId", () => {
    expect(buildArchivedProductSku("")).toBe(`${ARCHIVED_PRODUCT_SKU_PREFIX}PRODUCTO`);
  });
  it("resulting SKU is detected as archived by isArchivedProductSku", () => {
    const sku = buildArchivedProductSku("someid");
    expect(isArchivedProductSku(sku)).toBe(true);
  });
});

describe("isProductSkuCollision", () => {
  it("returns true for P2002 with array target containing businessId and sku", () => {
    expect(isProductSkuCollision({ code: "P2002", meta: { target: ["businessId", "sku"] } })).toBe(true);
  });
  it("returns false for P2002 with array target missing sku", () => {
    expect(isProductSkuCollision({ code: "P2002", meta: { target: ["businessId", "name"] } })).toBe(false);
  });
  it("returns true for P2002 with string target containing both keys", () => {
    expect(isProductSkuCollision({ code: "P2002", meta: { target: "businessId_sku_unique" } })).toBe(true);
  });
  it("returns false for P2002 with string target missing sku", () => {
    expect(isProductSkuCollision({ code: "P2002", meta: { target: "businessId_name_unique" } })).toBe(false);
  });
  it("returns true for P2002 with no target (broad check)", () => {
    expect(isProductSkuCollision({ code: "P2002" })).toBe(true);
  });
  it("returns false for other Prisma codes (P2025 with no businessId/sku context)", () => {
    expect(isProductSkuCollision({ code: "P2025" })).toBe(false);
  });
  it("returns true for error message containing both businessId and sku", () => {
    expect(isProductSkuCollision(new Error("Unique constraint on businessId and sku failed"))).toBe(true);
  });
  it("returns false for unrelated error message", () => {
    expect(isProductSkuCollision(new Error("connection timeout"))).toBe(false);
  });
  it("returns false for null", () => {
    expect(isProductSkuCollision(null)).toBe(false);
  });
  it("returns false for non-object primitive", () => {
    expect(isProductSkuCollision("P2002")).toBe(false);
  });
});
