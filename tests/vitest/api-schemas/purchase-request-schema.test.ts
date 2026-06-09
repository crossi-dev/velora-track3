import { describe, expect, it } from "vitest";
import { purchaseRequestCreateSchema } from "@/app/api/purchase-requests/purchase-request-schema";

const VALID_CUID = "abc123def456ghi789jk"; // 20 chars — matches /^[a-z0-9]{20,30}$/

describe("purchaseRequestCreateSchema", () => {
  it("accepts fully empty body (all fields optional)", () => {
    expect(purchaseRequestCreateSchema.safeParse({}).success).toBe(true);
  });
  it("accepts all optional fields populated", () => {
    expect(
      purchaseRequestCreateSchema.safeParse({
        supplierId: VALID_CUID,
        supplierName: "Proveedor SA",
        itemName: "Item 1",
        quantity: 5,
        unitPrice: 100,
      }).success
    ).toBe(true);
  });
  it("accepts null supplierId", () => {
    expect(purchaseRequestCreateSchema.safeParse({ supplierId: null }).success).toBe(true);
  });
  it("coerces unitPrice from numeric string", () => {
    const result = purchaseRequestCreateSchema.safeParse({ unitPrice: "99.50" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unitPrice).toBe(99.5);
  });
  it("treats empty string unitPrice as undefined", () => {
    const result = purchaseRequestCreateSchema.safeParse({ unitPrice: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unitPrice).toBeUndefined();
  });
  it("rejects negative quantity", () => {
    expect(purchaseRequestCreateSchema.safeParse({ quantity: -1 }).success).toBe(false);
  });
  it("rejects zero quantity", () => {
    expect(purchaseRequestCreateSchema.safeParse({ quantity: 0 }).success).toBe(false);
  });
  it("rejects negative unitPrice", () => {
    expect(purchaseRequestCreateSchema.safeParse({ unitPrice: -1 }).success).toBe(false);
  });
  it("rejects extra fields (strict mode)", () => {
    expect(purchaseRequestCreateSchema.safeParse({ businessId: "foo" }).success).toBe(false);
  });
  it("rejects supplierId with wrong CUID format", () => {
    expect(purchaseRequestCreateSchema.safeParse({ supplierId: "not-a-cuid" }).success).toBe(false);
  });
  it("rejects supplierName exceeding 255 chars", () => {
    expect(purchaseRequestCreateSchema.safeParse({ supplierName: "a".repeat(256) }).success).toBe(false);
  });
  it("rejects itemName exceeding 255 chars", () => {
    expect(purchaseRequestCreateSchema.safeParse({ itemName: "a".repeat(256) }).success).toBe(false);
  });
});
