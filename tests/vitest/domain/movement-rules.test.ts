import { describe, it, expect } from "vitest";
import { validateMovementAmount, validateMovementDescription } from "@/domain/rules/movement.rules";

describe("validateMovementAmount", () => {
  it("monto positivo → válido", () => expect(validateMovementAmount(500)).toBeNull());
  it("monto decimal > 0 → válido", () => expect(validateMovementAmount(0.01)).toBeNull());
  it("monto = 0 → error", () => expect(validateMovementAmount(0)).not.toBeNull());
  it("monto negativo → error", () => expect(validateMovementAmount(-100)).not.toBeNull());
  it("Infinity → error (no finito)", () => expect(validateMovementAmount(Infinity)).not.toBeNull());
  it("NaN → error (no finito)", () => expect(validateMovementAmount(NaN)).not.toBeNull());
});

describe("validateMovementDescription", () => {
  it("descripción normal → válida", () => expect(validateMovementDescription("Pago de alquiler")).toBeNull());
  it("descripción de un caracter → válida", () => expect(validateMovementDescription("X")).toBeNull());
  it("string vacío → error", () => expect(validateMovementDescription("")).not.toBeNull());
  it("solo espacios → error", () => expect(validateMovementDescription("   ")).not.toBeNull());
});
