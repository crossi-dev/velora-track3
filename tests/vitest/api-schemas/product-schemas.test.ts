import { describe, it, expect } from "vitest";
import {
  createProductBodySchema,
  updateProductBodySchema,
  deleteProductBodySchema,
} from "@/app/api/products/product-schema";
import { resolveOrCreateBodySchema } from "@/app/api/products/resolve-or-create/resolve-or-create-schema";

const VALID_CUID = "abc123def456ghi789jk"; // 20 chars

// ── createProductBodySchema ───────────────────────────────────────────────────

describe("createProductBodySchema", () => {
  const valid = { name: "Yerba 500g", price: 1500 };
  it("mínimo válido → parsea", () => expect(createProductBodySchema.safeParse(valid).success).toBe(true));
  it("con costPrice y stock → parsea", () => {
    expect(createProductBodySchema.safeParse({ ...valid, costPrice: 800, stock: 10 }).success).toBe(true);
  });
  it("nombre vacío → falla", () => expect(createProductBodySchema.safeParse({ ...valid, name: "" }).success).toBe(false));
  it("precio negativo → falla (nonnegative)", () => expect(createProductBodySchema.safeParse({ ...valid, price: -1 }).success).toBe(false));
  it("precio = 0 → parsea (nonnegative permite 0)", () => expect(createProductBodySchema.safeParse({ ...valid, price: 0 }).success).toBe(true));
  it("stock negativo → falla (nonnegative)", () => expect(createProductBodySchema.safeParse({ ...valid, stock: -1 }).success).toBe(false));
  it("stock decimal → falla (int)", () => expect(createProductBodySchema.safeParse({ ...valid, stock: 1.5 }).success).toBe(false));
  it("campo extra → falla (strict)", () => expect(createProductBodySchema.safeParse({ ...valid, businessId: "biz" }).success).toBe(false));
});

// ── updateProductBodySchema ───────────────────────────────────────────────────

describe("updateProductBodySchema", () => {
  const valid = { id: VALID_CUID };
  it("solo id → parsea", () => expect(updateProductBodySchema.safeParse(valid).success).toBe(true));
  it("con campos opcionales → parsea", () => {
    expect(updateProductBodySchema.safeParse({ ...valid, name: "Nuevo nombre", price: 200 }).success).toBe(true);
  });
  it("id con formato inválido → falla", () => {
    expect(updateProductBodySchema.safeParse({ id: "ID-CON-MAYUSCULAS" }).success).toBe(false);
  });
  it("price negativo → falla", () => {
    expect(updateProductBodySchema.safeParse({ ...valid, price: -1 }).success).toBe(false);
  });
  it("costPrice null → válido (nullable)", () => {
    expect(updateProductBodySchema.safeParse({ ...valid, costPrice: null }).success).toBe(true);
  });
  it("sku null → válido (nullable)", () => {
    expect(updateProductBodySchema.safeParse({ ...valid, sku: null }).success).toBe(true);
  });
  it("campo extra → falla (strict)", () => {
    expect(updateProductBodySchema.safeParse({ ...valid, extra: "x" }).success).toBe(false);
  });
});

// ── deleteProductBodySchema ───────────────────────────────────────────────────

describe("deleteProductBodySchema", () => {
  it("id válido → parsea", () => expect(deleteProductBodySchema.safeParse({ id: VALID_CUID }).success).toBe(true));
  it("id vacío → falla", () => expect(deleteProductBodySchema.safeParse({ id: "" }).success).toBe(false));
  it("id muy largo (>30 chars) → falla", () => {
    expect(deleteProductBodySchema.safeParse({ id: "a".repeat(31) }).success).toBe(false);
  });
  it("campo extra → falla (strict)", () => {
    expect(deleteProductBodySchema.safeParse({ id: VALID_CUID, name: "extra" }).success).toBe(false);
  });
});

// ── resolveOrCreateBodySchema ─────────────────────────────────────────────────

describe("resolveOrCreateBodySchema", () => {
  it("objeto vacío → parsea", () => expect(resolveOrCreateBodySchema.safeParse({}).success).toBe(true));
  it("con name y price → parsea", () => {
    expect(resolveOrCreateBodySchema.safeParse({ name: "Galletitas", price: 200 }).success).toBe(true);
  });
  it("price como string numérico → coerce y parsea", () => {
    expect(resolveOrCreateBodySchema.safeParse({ price: "150" }).success).toBe(true);
  });
  it("price como empty string → convierte a undefined → parsea", () => {
    expect(resolveOrCreateBodySchema.safeParse({ price: "" }).success).toBe(true);
  });
  it("price negativo → falla (nonnegative)", () => {
    expect(resolveOrCreateBodySchema.safeParse({ price: -1 }).success).toBe(false);
  });
  it("campo extra → falla (strict)", () => {
    expect(resolveOrCreateBodySchema.safeParse({ extra: "x" }).success).toBe(false);
  });
});
