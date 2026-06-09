import { describe, it, expect } from "vitest";
import { buildPeriodWindow } from "@/app/dashboard/lib/period-window";

// ── invariantes comunes ───────────────────────────────────────────────────────

describe("buildPeriodWindow — invariantes", () => {
  for (const period of ["today", "yesterday", "week", "month"] as const) {
    it(`${period}: startMs <= endMs`, () => {
      const w = buildPeriodWindow(period);
      expect(w.startMs).toBeLessThanOrEqual(w.endMs);
    });
    it(`${period}: label es string no vacío`, () => {
      expect(buildPeriodWindow(period).label.length).toBeGreaterThan(0);
    });
    it(`${period}: emptyLabel es string no vacío`, () => {
      expect(buildPeriodWindow(period).emptyLabel.length).toBeGreaterThan(0);
    });
  }
});

// ── today ─────────────────────────────────────────────────────────────────────

describe("buildPeriodWindow('today')", () => {
  it("startMs es medianoche local (hora = 0, minutos = 0, segundos = 0)", () => {
    const { startMs } = buildPeriodWindow("today");
    const d = new Date(startMs);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getMilliseconds()).toBe(0);
  });
  it("ventana < 24 horas", () => {
    const { startMs, endMs } = buildPeriodWindow("today");
    expect(endMs - startMs).toBeLessThan(24 * 60 * 60 * 1000);
  });
  it("label es 'Hoy'", () => {
    expect(buildPeriodWindow("today").label).toBe("Hoy");
  });
  it("endMs es el timestamp de la llamada (acotado entre before y after)", () => {
    const before = Date.now();
    const { endMs } = buildPeriodWindow("today");
    const after = Date.now();
    expect(endMs).toBeGreaterThanOrEqual(before);
    expect(endMs).toBeLessThanOrEqual(after);
  });
});

// ── yesterday ─────────────────────────────────────────────────────────────────

describe("buildPeriodWindow('yesterday')", () => {
  it("ventana es exactamente 24 horas (hasta 1ms antes de hoy)", () => {
    const { startMs, endMs } = buildPeriodWindow("yesterday");
    expect(endMs - startMs + 1).toBe(24 * 60 * 60 * 1000);
  });
  it("endMs es 1ms antes de la medianoche de hoy", () => {
    const todayMidnight = new Date();
    todayMidnight.setHours(0, 0, 0, 0);
    const { endMs } = buildPeriodWindow("yesterday");
    expect(endMs).toBe(todayMidnight.getTime() - 1);
  });
  it("startMs es la medianoche de ayer", () => {
    const { startMs, endMs } = buildPeriodWindow("yesterday");
    const start = new Date(startMs);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(start.getSeconds()).toBe(0);
    expect(start.getMilliseconds()).toBe(0);
    // La ventana de ayer termina 1ms antes de la medianoche de hoy
    expect(endMs - startMs).toBe(24 * 60 * 60 * 1000 - 1);
  });
  it("label es 'Ayer'", () => {
    expect(buildPeriodWindow("yesterday").label).toBe("Ayer");
  });
});

// ── week ──────────────────────────────────────────────────────────────────────

describe("buildPeriodWindow('week')", () => {
  it("startMs es lunes (getDay() === 1)", () => {
    const { startMs } = buildPeriodWindow("week");
    expect(new Date(startMs).getDay()).toBe(1);
  });
  it("startMs es medianoche local del lunes", () => {
    const { startMs } = buildPeriodWindow("week");
    const d = new Date(startMs);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });
  it("ventana ≤ 7 días", () => {
    const { startMs, endMs } = buildPeriodWindow("week");
    expect(endMs - startMs).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });
  it("label es 'Esta semana'", () => {
    expect(buildPeriodWindow("week").label).toBe("Esta semana");
  });
});

// ── month ─────────────────────────────────────────────────────────────────────

describe("buildPeriodWindow('month')", () => {
  it("startMs es el día 1 del mes", () => {
    const { startMs } = buildPeriodWindow("month");
    expect(new Date(startMs).getDate()).toBe(1);
  });
  it("startMs es medianoche local del 1ro", () => {
    const { startMs } = buildPeriodWindow("month");
    const d = new Date(startMs);
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
  });
  it("startMs y endMs son del mismo mes/año", () => {
    const { startMs, endMs } = buildPeriodWindow("month");
    const start = new Date(startMs);
    const end = new Date(endMs);
    expect(start.getMonth()).toBe(end.getMonth());
    expect(start.getFullYear()).toBe(end.getFullYear());
  });
  it("label es 'Este mes'", () => {
    expect(buildPeriodWindow("month").label).toBe("Este mes");
  });
});
