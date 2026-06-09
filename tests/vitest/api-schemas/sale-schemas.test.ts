import { describe, it, expect } from "vitest";
import { createSaleBodySchema, saleItemSchema } from "@/app/api/sales/create/sale-schema";

const VALID_CUID = "abc123def456ghi789jk"; // 20 chars, /^[a-z0-9]{20,30}$/

// ── saleItemSchema ────────────────────────────────────────────────────────────

describe("saleItemSchema", () => {
  const valid = { productId: VALID_CUID, quantity: 2, unitPrice: 100 };
  it("ítem válido → parsea", () => expect(saleItemSchema.safeParse(valid).success).toBe(true));
  it("productId vacío → falla", () => expect(saleItemSchema.safeParse({ ...valid, productId: "" }).success).toBe(false));
  it("productId muy corto (<20 chars) → falla", () => expect(saleItemSchema.safeParse({ ...valid, productId: "abc123" }).success).toBe(false));
  it("quantity decimal → falla (int)", () => expect(saleItemSchema.safeParse({ ...valid, quantity: 1.5 }).success).toBe(false));
  it("quantity = 0 → falla (positive)", () => expect(saleItemSchema.safeParse({ ...valid, quantity: 0 }).success).toBe(false));
  it("unitPrice = 0 → falla (positive)", () => expect(saleItemSchema.safeParse({ ...valid, unitPrice: 0 }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(saleItemSchema.safeParse({ ...valid, extra: true }).success).toBe(false));
});

// ── createSaleBodySchema ──────────────────────────────────────────────────────

describe("createSaleBodySchema", () => {
  const validItem = { productId: VALID_CUID, quantity: 1, unitPrice: 500 };
  const valid = { items: [validItem], total: 500 };

  it("venta mínima → parsea", () => expect(createSaleBodySchema.safeParse(valid).success).toBe(true));
  it("venta con cliente → parsea", () => {
    expect(createSaleBodySchema.safeParse({ ...valid, customerId: VALID_CUID }).success).toBe(true);
  });
  it("items vacío → falla (min 1)", () => {
    expect(createSaleBodySchema.safeParse({ ...valid, items: [] }).success).toBe(false);
  });
  it("total = 0 → falla (positive)", () => {
    expect(createSaleBodySchema.safeParse({ ...valid, total: 0 }).success).toBe(false);
  });
  it("campo extra → falla (strict)", () => {
    expect(createSaleBodySchema.safeParse({ ...valid, businessId: "biz-123" }).success).toBe(false);
  });
});
