// Regression guard: weightGrams must be accepted (not stripped/rejected) on both
// createProductBodySchema and updateProductBodySchema.
//
// Root cause of the original bug: schemas used .strict() but did not declare
// weightGrams as a field, so any request carrying it got a Zod 400.
// This test catches a re-introduction of that regression.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createProductBodySchema,
  updateProductBodySchema,
} = require("../../src/app/api/products/product-schema.ts");

// ── createProductBodySchema ───────────────────────────────────────────────────

test("create: valid payload without weightGrams passes", () => {
  const result = createProductBodySchema.safeParse({
    name: "Fernet 1L",
    price: 2500,
  });
  assert.equal(result.success, true);
});

test("create: valid payload with weightGrams passes", () => {
  const result = createProductBodySchema.safeParse({
    name: "Fernet 1L",
    price: 2500,
    weightGrams: 750,
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.weightGrams, 750);
  }
});

test("create: weightGrams must be a positive integer", () => {
  const result = createProductBodySchema.safeParse({
    name: "Fernet 1L",
    price: 2500,
    weightGrams: 0,
  });
  assert.equal(result.success, false);
});

test("create: weightGrams must not exceed 500_000", () => {
  const result = createProductBodySchema.safeParse({
    name: "Fernet 1L",
    price: 2500,
    weightGrams: 500_001,
  });
  assert.equal(result.success, false);
});

test("create: weightGrams at upper boundary (500_000) passes", () => {
  const result = createProductBodySchema.safeParse({
    name: "Arena Gruesa",
    price: 1000,
    weightGrams: 500_000,
  });
  assert.equal(result.success, true);
});

test("create: weightGrams as float is rejected (must be integer)", () => {
  const result = createProductBodySchema.safeParse({
    name: "Fernet 1L",
    price: 2500,
    weightGrams: 750.5,
  });
  assert.equal(result.success, false);
});

// ── updateProductBodySchema ───────────────────────────────────────────────────

test("update: valid payload with weightGrams passes", () => {
  const result = updateProductBodySchema.safeParse({
    id: "abc12345678901234567890",
    weightGrams: 500,
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.weightGrams, 500);
  }
});

test("update: weightGrams null (clear) passes", () => {
  const result = updateProductBodySchema.safeParse({
    id: "abc12345678901234567890",
    weightGrams: null,
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.weightGrams, null);
  }
});

test("update: weightGrams omitted passes (no change)", () => {
  const result = updateProductBodySchema.safeParse({
    id: "abc12345678901234567890",
    name: "Nuevo nombre",
  });
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.weightGrams, undefined);
  }
});

test("update: weightGrams 0 is rejected (must be positive)", () => {
  const result = updateProductBodySchema.safeParse({
    id: "abc12345678901234567890",
    weightGrams: 0,
  });
  assert.equal(result.success, false);
});

test("update: weightGrams exceeding 500_000 is rejected", () => {
  const result = updateProductBodySchema.safeParse({
    id: "abc12345678901234567890",
    weightGrams: 600_000,
  });
  assert.equal(result.success, false);
});

test("update: unknown field still rejected by strict schema", () => {
  const result = updateProductBodySchema.safeParse({
    id: "abc12345678901234567890",
    unknownField: "boom",
  });
  assert.equal(result.success, false);
});
