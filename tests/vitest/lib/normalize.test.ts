import { describe, expect, it } from "vitest";
import {
  normalizeForMatching,
  normalizeInput,
  normalizeNullableInput,
  normalizePersonOrBusinessName,
  normalizeSupplierName,
  normalizeSupplierLookupText,
  normalizeSupplierNullableText,
  normalizeCustomerName,
  normalizeCustomerNullableText,
} from "@/lib/normalize";

describe("normalizeForMatching", () => {
  it("lowercases ASCII input", () => expect(normalizeForMatching("HELLO")).toBe("hello"));
  it("strips acute accent from é", () => expect(normalizeForMatching("café")).toBe("cafe"));
  it("strips tilde from ñ", () => expect(normalizeForMatching("niño")).toBe("nino"));
  it("strips accents from uppercase Á", () => expect(normalizeForMatching("ÁNGEL")).toBe("angel"));
  it("preserves spaces", () => expect(normalizeForMatching("Juan López")).toBe("juan lopez"));
  it("empty string returns empty", () => expect(normalizeForMatching("")).toBe(""));
  it("strips all combining marks in a word", () => expect(normalizeForMatching("ü")).toBe("u"));
});

describe("normalizeInput", () => {
  it("trims leading and trailing whitespace", () => expect(normalizeInput("  hello  ")).toBe("hello"));
  it("returns empty string for number", () => expect(normalizeInput(42)).toBe(""));
  it("returns empty string for null", () => expect(normalizeInput(null)).toBe(""));
  it("returns empty string for undefined", () => expect(normalizeInput(undefined)).toBe(""));
  it("returns empty string for object", () => expect(normalizeInput({})).toBe(""));
  it("applies maxLen after trim", () => expect(normalizeInput("abcdef", 3)).toBe("abc"));
  it("omitting maxLen keeps full string", () => expect(normalizeInput("abcdef")).toBe("abcdef"));
  it("empty string returns empty", () => expect(normalizeInput("")).toBe(""));
  it("trims then slices — whitespace does not count toward maxLen", () => {
    expect(normalizeInput("  abcdef  ", 3)).toBe("abc");
  });
});

describe("normalizeNullableInput", () => {
  it("returns null for non-string (number)", () => expect(normalizeNullableInput(0)).toBeNull());
  it("returns null for null", () => expect(normalizeNullableInput(null)).toBeNull());
  it("returns null for empty string", () => expect(normalizeNullableInput("")).toBeNull());
  it("returns null for whitespace-only string", () => expect(normalizeNullableInput("   ")).toBeNull());
  it("trims and returns non-empty string", () => expect(normalizeNullableInput("  hello  ")).toBe("hello"));
  it("applies maxLen", () => expect(normalizeNullableInput("abcdef", 3)).toBe("abc"));
  it("returns null when trimmed result is empty after maxLen slice", () => {
    expect(normalizeNullableInput("", 3)).toBeNull();
  });
});

describe("normalizePersonOrBusinessName", () => {
  it("capitalizes first letter of first word", () => {
    expect(normalizePersonOrBusinessName("juan")).toBe("Juan");
  });
  it("capitalizes first letter of each word", () => {
    expect(normalizePersonOrBusinessName("juan perez")).toBe("Juan Perez");
  });
  it("keeps Spanish particles lowercase in non-leading position (de, la)", () => {
    expect(normalizePersonOrBusinessName("juan de la cruz")).toBe("Juan de la Cruz");
  });
  it("keeps 'del' particle lowercase in non-leading position", () => {
    expect(normalizePersonOrBusinessName("pedro del valle")).toBe("Pedro del Valle");
  });
  it("capitalizes particle when it is the first word", () => {
    expect(normalizePersonOrBusinessName("de la paz")).toBe("De la Paz");
  });
  it("capitalizes post-hyphen letter in compound names", () => {
    expect(normalizePersonOrBusinessName("maria-jose")).toBe("Maria-Jose");
  });
  it("returns empty for empty string", () => expect(normalizePersonOrBusinessName("")).toBe(""));
  it("handles all-caps input", () => {
    expect(normalizePersonOrBusinessName("JUAN PEREZ")).toBe("Juan Perez");
  });
  it("collapses extra internal whitespace", () => {
    expect(normalizePersonOrBusinessName("  juan   perez  ")).toBe("Juan Perez");
  });
});

describe("normalizeSupplierName", () => {
  it("returns empty string for null", () => expect(normalizeSupplierName(null)).toBe(""));
  it("returns empty string for non-string", () => expect(normalizeSupplierName(42)).toBe(""));
  it("title-cases supplier name", () => expect(normalizeSupplierName("COCA COLA")).toBe("Coca Cola"));
  it("capitalizes post-hyphen letter", () => expect(normalizeSupplierName("coca-cola")).toBe("Coca-Cola"));
  it("applies maxLen truncation before casing", () => {
    expect(normalizeSupplierName("abcdef", 3)).toBe("Abc");
  });
  it("returns empty for whitespace-only string", () => expect(normalizeSupplierName("   ")).toBe(""));
});

describe("normalizeSupplierLookupText", () => {
  it("lowercases and strips acute accent", () => expect(normalizeSupplierLookupText("Café")).toBe("cafe"));
  it("trims whitespace", () => expect(normalizeSupplierLookupText("  hello  ")).toBe("hello"));
  it("strips tilde from ñ", () => expect(normalizeSupplierLookupText("Señor")).toBe("senor"));
  it("empty string returns empty", () => expect(normalizeSupplierLookupText("")).toBe(""));
});

describe("normalizeSupplierNullableText", () => {
  it("returns null for non-string", () => expect(normalizeSupplierNullableText(42)).toBeNull());
  it("returns null for empty string", () => expect(normalizeSupplierNullableText("")).toBeNull());
  it("returns null for whitespace-only", () => expect(normalizeSupplierNullableText("  ")).toBeNull());
  it("trims and returns value", () => expect(normalizeSupplierNullableText("  hello  ")).toBe("hello"));
  it("applies maxLen", () => expect(normalizeSupplierNullableText("abcdef", 3)).toBe("abc"));
});

describe("normalizeCustomerName", () => {
  it("returns empty for null", () => expect(normalizeCustomerName(null)).toBe(""));
  it("title-cases customer name", () => expect(normalizeCustomerName("JOHN DOE")).toBe("John Doe"));
  it("applies maxLen and title-cases result", () => expect(normalizeCustomerName("abcdef", 3)).toBe("Abc"));
  it("returns empty for whitespace only", () => expect(normalizeCustomerName("   ")).toBe(""));
});

describe("normalizeCustomerNullableText", () => {
  it("returns null for null", () => expect(normalizeCustomerNullableText(null)).toBeNull());
  it("returns null for empty string", () => expect(normalizeCustomerNullableText("")).toBeNull());
  it("returns null for whitespace-only", () => expect(normalizeCustomerNullableText("  ")).toBeNull());
  it("trims and returns value", () => expect(normalizeCustomerNullableText("  hello  ")).toBe("hello"));
  it("applies maxLen", () => expect(normalizeCustomerNullableText("abcdef", 3)).toBe("abc"));
});
