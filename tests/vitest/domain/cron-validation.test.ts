import { describe, it, expect } from "vitest";
import {
  isValidCronExpression,
  validateTimeTrigger,
  validateConditionTrigger,
} from "@/domain/rules/cron-validation";

describe("isValidCronExpression", () => {
  it("todos los campos wildcard → válido", () => expect(isValidCronExpression("* * * * *")).toBe(true));
  it("step */N → válido", () => expect(isValidCronExpression("*/15 * * * *")).toBe(true));
  it("rango y lista combinados → válido", () => expect(isValidCronExpression("0,30 9-17 * * 1-5")).toBe(true));
  it("entero simple en cada campo → válido", () => expect(isValidCronExpression("0 9 1 6 3")).toBe(true));
  it("menos de 5 campos → inválido", () => expect(isValidCronExpression("* * * *")).toBe(false));
  it("más de 5 campos → inválido", () => expect(isValidCronExpression("* * * * * *")).toBe(false));
  it("step */0 → inválido (N debe ser ≥ 1)", () => expect(isValidCronExpression("*/0 * * * *")).toBe(false));
  it("campo no numérico → inválido", () => expect(isValidCronExpression("abc * * * *")).toBe(false));
  it("string vacío → inválido", () => expect(isValidCronExpression("")).toBe(false));
  it("solo valida estructura, no rangos (60 pasa aunque no exista minuto 60)", () =>
    expect(isValidCronExpression("60 * * * *")).toBe(true));
});

describe("validateTimeTrigger", () => {
  it("expresión de 5 campos válida → null", () => expect(validateTimeTrigger("*/30 * * * *")).toBeNull());
  it("minuto/hora concretos con día de semana en rango → null", () =>
    expect(validateTimeTrigger("0 9 * * 1-5")).toBeNull());
  it("menos de 5 campos → error de estructura", () => {
    const result = validateTimeTrigger("* * * *");
    expect(result).not.toBeNull();
    expect(result).toContain("5-field cron expression");
  });
  it("día-del-mes distinto de \"*\" → error", () => {
    const result = validateTimeTrigger("0 9 1 * *");
    expect(result).not.toBeNull();
    expect(result).toContain("day-of-month and month fields must be");
  });
  it("mes distinto de \"*\" → error", () => {
    const result = validateTimeTrigger("0 9 * 3 *");
    expect(result).not.toBeNull();
    expect(result).toContain("day-of-month and month fields must be");
  });
  it("minuto fuera de rango (60) → error mencionando minute", () => {
    const result = validateTimeTrigger("60 * * * *");
    expect(result).not.toBeNull();
    expect(result).toContain("minute");
  });
  it("hora fuera de rango (24) → error mencionando hour", () => {
    const result = validateTimeTrigger("0 24 * * *");
    expect(result).not.toBeNull();
    expect(result).toContain("hour");
  });
  it("day-of-week fuera de rango (7) → error mencionando day-of-week", () => {
    const result = validateTimeTrigger("0 9 * * 7");
    expect(result).not.toBeNull();
    expect(result).toContain("day-of-week");
  });
  it("step de minuto excede el máximo (*/61) → error", () => {
    const result = validateTimeTrigger("*/61 * * * *");
    expect(result).not.toBeNull();
  });
  it("rango de minuto fuera de límites (0-70) → error", () => {
    const result = validateTimeTrigger("0-70 * * * *");
    expect(result).not.toBeNull();
  });
});

describe("validateConditionTrigger", () => {
  it("prefijo conocido stock_below: → null", () => expect(validateConditionTrigger("stock_below:10")).toBeNull());
  it("prefijo conocido con contenido arbitrario → null", () =>
    expect(validateConditionTrigger("stock_below:SKU-123<5")).toBeNull());
  it("espacios alrededor del trigger se recortan antes de validar → null", () =>
    expect(validateConditionTrigger("  stock_below:5  ")).toBeNull());
  it("prefijo desconocido → error", () => {
    const result = validateConditionTrigger("foo:bar");
    expect(result).not.toBeNull();
    expect(result).toContain("condition-based trigger must start with one of");
  });
  it("string vacío → error", () => expect(validateConditionTrigger("")).not.toBeNull());
});
