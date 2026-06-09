const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeLookupText,
  normalizePersonOrBusinessName,
  splitCustomerName,
  buildCustomerFullName,
  translateBusinessType,
} = require("../../src/lib/shared-utils.ts");

// ── normalizeLookupText ──

test("normalizeLookupText lowercases and trims", () => {
  assert.equal(normalizeLookupText("  Arena Gruesa  "), "arena gruesa");
});

test("normalizeLookupText strips accents", () => {
  assert.equal(normalizeLookupText("José María"), "jose maria");
});

test("normalizeLookupText handles empty string", () => {
  assert.equal(normalizeLookupText(""), "");
});

// ── normalizePersonOrBusinessName ──

test("normalizePersonOrBusinessName capitalizes words", () => {
  assert.equal(normalizePersonOrBusinessName("juan pérez"), "Juan Pérez");
});

test("normalizePersonOrBusinessName trims whitespace", () => {
  assert.equal(normalizePersonOrBusinessName("  maría  "), "María");
});

test("normalizePersonOrBusinessName handles empty", () => {
  assert.equal(normalizePersonOrBusinessName(""), "");
});

// ── splitCustomerName ──

test("splitCustomerName splits first and last name", () => {
  const result = splitCustomerName("Juan Pérez");
  assert.equal(result.firstName, "Juan");
  assert.equal(result.lastName, "Pérez");
});

test("splitCustomerName single word has no lastName", () => {
  const result = splitCustomerName("María");
  assert.equal(result.firstName, "María");
  assert.equal(result.lastName, "");
});

// ── buildCustomerFullName ──

test("buildCustomerFullName joins first and last", () => {
  assert.equal(buildCustomerFullName("Juan", "Pérez"), "Juan Pérez");
});

test("buildCustomerFullName first only", () => {
  assert.equal(buildCustomerFullName("Juan", ""), "Juan");
});

// ── translateBusinessType ──

test("translateBusinessType maps Retail to Comercio", () => {
  assert.equal(translateBusinessType("Retail", "es-419"), "Comercio");
});

test("translateBusinessType maps Hardware to Ferretería", () => {
  assert.equal(translateBusinessType("Hardware", "es-419"), "Ferretería");
});

test("translateBusinessType unknown type returns as-is", () => {
  assert.equal(translateBusinessType("spaceship", "en"), "spaceship");
});
