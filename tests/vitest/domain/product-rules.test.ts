import { describe, it, expect } from "vitest";
import { validateProductName, validateProductPrice } from "@/domain/rules/product.rules";

describe("validateProductName", () => {
  it("nombre normal → válido", () => expect(validateProductName("Laptop Dell")).toBeNull());
  it("un solo caracter → válido", () => expect(validateProductName("A")).toBeNull());
  it("string vacío → error", () => expect(validateProductName("")).not.toBeNull());
  it("solo espacios → error", () => expect(validateProductName("   ")).not.toBeNull());
  it("retorna string de error no nulo", () => {
    const result = validateProductName("");
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeGreaterThan(0);
  });
});

describe("validateProductPrice", () => {
  it("precio positivo → válido", () => expect(validateProductPrice(100)).toBeNull());
  it("precio decimal > 0 → válido", () => expect(validateProductPrice(0.01)).toBeNull());
  it("precio = 0 → error", () => expect(validateProductPrice(0)).not.toBeNull());
  it("precio negativo → error", () => expect(validateProductPrice(-1)).not.toBeNull());
  it("Infinity → error (no finito)", () => expect(validateProductPrice(Infinity)).not.toBeNull());
  it("NaN → error (no finito)", () => expect(validateProductPrice(NaN)).not.toBeNull());
  it("-Infinity → error", () => expect(validateProductPrice(-Infinity)).not.toBeNull());
});
