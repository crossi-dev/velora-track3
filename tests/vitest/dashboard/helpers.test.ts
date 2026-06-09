import { describe, it, expect } from "vitest";
import { toFiniteNumber, moneyFmt, formatDate, movementTypeLabel } from "@/app/dashboard/lib/helpers";

// ── toFiniteNumber ────────────────────────────────────────────────────────────

describe("toFiniteNumber", () => {
  it("número finito → mismo valor", () => expect(toFiniteNumber(42)).toBe(42));
  it("decimal → mismo valor", () => expect(toFiniteNumber(3.14)).toBe(3.14));
  it("cero → 0", () => expect(toFiniteNumber(0)).toBe(0));
  it("negativo → mismo valor", () => expect(toFiniteNumber(-5)).toBe(-5));
  it("string numérico → convierte", () => expect(toFiniteNumber("100")).toBe(100));
  it("string no numérico → 0", () => expect(toFiniteNumber("abc")).toBe(0));
  it("null → 0", () => expect(toFiniteNumber(null)).toBe(0));
  it("undefined → 0", () => expect(toFiniteNumber(undefined)).toBe(0));
  it("Infinity → 0 (no finito)", () => expect(toFiniteNumber(Infinity)).toBe(0));
  it("-Infinity → 0 (no finito)", () => expect(toFiniteNumber(-Infinity)).toBe(0));
  it("NaN → 0 (no finito)", () => expect(toFiniteNumber(NaN)).toBe(0));
  it("boolean true → 1 (Number(true) = 1, finito)", () => expect(toFiniteNumber(true)).toBe(1));
  it("boolean false → 0 (Number(false) = 0, finito)", () => expect(toFiniteNumber(false)).toBe(0));
});

// ── moneyFmt ──────────────────────────────────────────────────────────────────
// SiteLocale = "es-419" only → moneyFmt uses es-AR formatting (decimal sep = ",").

describe("moneyFmt", () => {
  it("empieza con el símbolo de moneda", () => {
    expect(moneyFmt(1000, "ARS", "es-419")).toMatch(/^ARS/);
  });
  it("usa currency pasada como parámetro", () => {
    expect(moneyFmt(100, "USD", "es-419")).toMatch(/^USD/);
  });
  it("fallback a ARS si currency es vacío", () => {
    expect(moneyFmt(100, "", "es-419")).toMatch(/^ARS/);
  });
  it("valor no-finito → formatea como 0", () => {
    const result = moneyFmt(NaN, "ARS", "es-419");
    // es-AR decimal separator is "," → "0,00"
    expect(result).toContain("0");
    expect(result).toMatch(/^ARS/);
  });
  it("incluye separador decimal en el resultado", () => {
    const result = moneyFmt(1000, "ARS", "es-419");
    // es-AR: "ARS 1.000,00" — has a decimal separator (comma) before last 2 digits
    expect(result).toMatch(/^ARS/);
    expect(result).toMatch(/[,]\d{2}$/);
  });
  it("valor 0 → formatea con decimales", () => {
    const result = moneyFmt(0, "ARS", "es-419");
    expect(result).toContain("0");
    expect(result).toMatch(/^ARS/);
  });
});

// ── formatDate ────────────────────────────────────────────────────────────────

describe("formatDate", () => {
  it("es-419 → devuelve string de fecha no vacío", () => {
    // Use local noon to avoid UTC midnight rolling over to the previous day in UTC-N zones.
    const result = formatDate("2024-01-15T12:00:00", "es-419");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
  it("es-419 → devuelve string no vacío para otra fecha", () => {
    const result = formatDate("2024-06-20", "es-419");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
  it("fecha diferente → resultado diferente", () => {
    expect(formatDate("2024-01-01T12:00:00", "es-419")).not.toBe(formatDate("2024-12-31T12:00:00", "es-419"));
  });
});

// ── movementTypeLabel ─────────────────────────────────────────────────────────

describe("movementTypeLabel", () => {
  const tEn = (en: string, _es: string) => en;
  const tEs = (_en: string, es: string) => es;

  it("sale → 'Sale' en inglés, 'Venta' en español", () => {
    expect(movementTypeLabel("sale", tEn)).toBe("Sale");
    expect(movementTypeLabel("sale", tEs)).toBe("Venta");
  });
  it("purchase → Compra / Compra", () => {
    expect(movementTypeLabel("purchase", tEn)).toBe("Compra");
  });
  it("tax → 'Pago de impuestos'", () => {
    expect(movementTypeLabel("tax", tEn)).toBe("Pago de impuestos");
  });
  it("salary → 'Pago de salarios'", () => {
    expect(movementTypeLabel("salary", tEn)).toBe("Pago de salarios");
  });
  it("adjustment → 'Ajuste de caja'", () => {
    expect(movementTypeLabel("adjustment", tEn)).toBe("Ajuste de caja");
  });
  it("tipo desconocido → retorna el valor original", () => {
    expect(movementTypeLabel("unknown_type", tEn)).toBe("unknown_type");
  });
  it("string vacío → retorna string vacío", () => {
    expect(movementTypeLabel("", tEn)).toBe("");
  });
});
