import { describe, expect, it } from "vitest";
import {
  normalizeLookupText,
  splitCustomerName,
  buildCustomerFullName,
  translateBusinessType,
} from "@/lib/shared-utils";

describe("normalizeLookupText", () => {
  it("lowercases input", () => expect(normalizeLookupText("HELLO")).toBe("hello"));
  it("strips acute accent", () => expect(normalizeLookupText("café")).toBe("cafe"));
  it("strips tilde from ñ", () => expect(normalizeLookupText("niño")).toBe("nino"));
  it("trims whitespace", () => expect(normalizeLookupText("  hello  ")).toBe("hello"));
  it("empty string returns empty", () => expect(normalizeLookupText("")).toBe(""));
});

describe("splitCustomerName", () => {
  it("single word → firstName, empty lastName", () => {
    expect(splitCustomerName("Juan")).toEqual({ firstName: "Juan", lastName: "" });
  });
  it("two words → firstName + lastName", () => {
    expect(splitCustomerName("Juan Perez")).toEqual({ firstName: "Juan", lastName: "Perez" });
  });
  it("three words → firstName + compound lastName", () => {
    expect(splitCustomerName("Juan Carlos Perez")).toEqual({ firstName: "Juan", lastName: "Carlos Perez" });
  });
  it("empty string → both empty", () => {
    expect(splitCustomerName("")).toEqual({ firstName: "", lastName: "" });
  });
  it("normalizes casing before splitting", () => {
    const result = splitCustomerName("JUAN PEREZ");
    expect(result.firstName).toBe("Juan");
    expect(result.lastName).toBe("Perez");
  });
  it("Spanish particle in last name stays lowercase", () => {
    const result = splitCustomerName("Juan de la Cruz");
    expect(result.firstName).toBe("Juan");
    expect(result.lastName).toBe("de la Cruz");
  });
});

describe("buildCustomerFullName", () => {
  it("joins first and last name with normalization", () => {
    expect(buildCustomerFullName("juan", "perez")).toBe("Juan Perez");
  });
  it("trims extra whitespace from both parts", () => {
    expect(buildCustomerFullName("  juan  ", "  perez  ")).toBe("Juan Perez");
  });
  it("empty lastName results in firstName only", () => {
    expect(buildCustomerFullName("Juan", "")).toBe("Juan");
  });
  it("empty firstName results in lastName only", () => {
    expect(buildCustomerFullName("", "Perez")).toBe("Perez");
  });
});

describe("translateBusinessType", () => {
  it("translates 'Retail' to 'Comercio'", () => {
    expect(translateBusinessType("Retail", "es-419")).toBe("Comercio");
  });
  it("translates 'Hardware' to 'Ferretería'", () => {
    expect(translateBusinessType("Hardware", "es-419")).toBe("Ferretería");
  });
  it("translates 'Auto Parts' to 'Repuestos'", () => {
    expect(translateBusinessType("Auto Parts", "es-419")).toBe("Repuestos");
  });
  it("translates 'Food & Drink' to 'Gastronomía'", () => {
    expect(translateBusinessType("Food & Drink", "es-419")).toBe("Gastronomía");
  });
  it("falls back to original string for unknown type", () => {
    expect(translateBusinessType("UnknownType", "es-419")).toBe("UnknownType");
  });
});
