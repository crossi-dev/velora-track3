import { describe, expect, it } from "vitest";
import { stockLoadSchema } from "@/app/api/stock-loads/stock-load-schema";

const VALID_CUID = "abc123def456ghi789jk"; // 20 chars — matches /^[a-z0-9]{20,30}$/

describe("stockLoadSchema", () => {
  it("accepts productId + quantity", () => {
    expect(stockLoadSchema.safeParse({ productId: VALID_CUID, quantity: 10 }).success).toBe(true);
  });
  it("accepts itemName + quantity", () => {
    expect(stockLoadSchema.safeParse({ itemName: "Producto A", quantity: 5 }).success).toBe(true);
  });
  it("rejects when neither productId nor itemName provided", () => {
    const result = stockLoadSchema.safeParse({ quantity: 10 });
    expect(result.success).toBe(false);
  });
  it("accepts both productId and itemName together", () => {
    expect(
      stockLoadSchema.safeParse({ productId: VALID_CUID, itemName: "Producto A", quantity: 1 }).success
    ).toBe(true);
  });
  it("rejects zero quantity", () => {
    expect(stockLoadSchema.safeParse({ itemName: "X", quantity: 0 }).success).toBe(false);
  });
  it("rejects negative quantity", () => {
    expect(stockLoadSchema.safeParse({ itemName: "X", quantity: -1 }).success).toBe(false);
  });
  it("coerces quantity from numeric string", () => {
    const result = stockLoadSchema.safeParse({ itemName: "X", quantity: "10" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.quantity).toBe(10);
  });
  it("coerces unitPrice from numeric string", () => {
    const result = stockLoadSchema.safeParse({ itemName: "X", quantity: 1, unitPrice: "99.9" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unitPrice).toBe(99.9);
  });
  it("accepts null unitPrice", () => {
    expect(stockLoadSchema.safeParse({ itemName: "X", quantity: 1, unitPrice: null }).success).toBe(true);
  });
  it("treats empty string unitPrice as undefined", () => {
    const result = stockLoadSchema.safeParse({ itemName: "X", quantity: 1, unitPrice: "" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.unitPrice).toBeUndefined();
  });
  it("rejects negative unitPrice", () => {
    expect(stockLoadSchema.safeParse({ itemName: "X", quantity: 1, unitPrice: -5 }).success).toBe(false);
  });
  it("rejects extra fields (strict mode)", () => {
    expect(stockLoadSchema.safeParse({ itemName: "X", quantity: 1, extra: "foo" }).success).toBe(false);
  });
  it("accepts optional boolean flags", () => {
    expect(
      stockLoadSchema.safeParse({
        itemName: "X",
        quantity: 1,
        createPurchaseRequest: true,
        autoCreateProduct: false,
      }).success
    ).toBe(true);
  });
  it("accepts optional note field", () => {
    expect(stockLoadSchema.safeParse({ itemName: "X", quantity: 1, note: "some note" }).success).toBe(true);
  });
  it("rejects note exceeding 500 chars", () => {
    expect(stockLoadSchema.safeParse({ itemName: "X", quantity: 1, note: "a".repeat(501) }).success).toBe(false);
  });
});
