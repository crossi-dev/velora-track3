import { describe, expect, it } from "vitest";
import { collapseSplitKeywords } from "@/app/dashboard/lib/collapse-split-keywords";

describe("collapseSplitKeywords", () => {
  it("returns empty string for empty input", () => {
    expect(collapseSplitKeywords("")).toBe("");
  });
  it("returns unchanged text when no split keywords are present", () => {
    expect(collapseSplitKeywords("agregar nuevo")).toBe("agregar nuevo");
  });
  it("returns unchanged single token", () => {
    expect(collapseSplitKeywords("stock")).toBe("stock");
  });
  it("repairs 'stoc k' → 'stock'", () => {
    expect(collapseSplitKeywords("ver stoc k")).toBe("ver stock");
  });
  it("repairs 'inven tario' → 'inventario'", () => {
    expect(collapseSplitKeywords("ver inven tario")).toBe("ver inventario");
  });
  it("repairs 'pro ducto' → 'producto'", () => {
    expect(collapseSplitKeywords("ver pro ducto")).toBe("ver producto");
  });
  it("repairs 'cata logo' → 'catalogo'", () => {
    expect(collapseSplitKeywords("ver cata logo")).toBe("ver catalogo");
  });
  it("collapses internal newlines before repair", () => {
    expect(collapseSplitKeywords("ver stoc\nk")).toBe("ver stock");
  });
  it("does not merge unrelated adjacent words (false-positive guard: 'mi stock')", () => {
    expect(collapseSplitKeywords("mi stock")).toBe("mi stock");
  });
  it("does not merge 'bana na' — 'banana' is not in the allowlist", () => {
    expect(collapseSplitKeywords("bana na")).toBe("bana na");
  });
  it("repairs multiple split keywords in one string", () => {
    expect(collapseSplitKeywords("stoc k y pro ducto")).toBe("stock y producto");
  });
  it("handles whitespace-only input", () => {
    expect(collapseSplitKeywords("   ")).toBe("");
  });
});
