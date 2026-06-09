const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeSkuBase,
  buildUniqueSku,
  normalizeProvidedSku,
  normalizeSkuLookup,
  isArchivedProductSku,
  buildArchivedProductSku,
  ARCHIVED_PRODUCT_SKU_PREFIX,
} = require("../../src/infrastructure/shared/product-sku.ts");

// ── normalizeSkuBase ──

test("normalizeSkuBase: basic product name", () => {
  assert.equal(normalizeSkuBase("Arena Gruesa"), "ARENA-GRUESA");
});

test("normalizeSkuBase: strips accents", () => {
  assert.equal(normalizeSkuBase("Café Orgánico"), "CAFE-ORGANICO");
});

test("normalizeSkuBase: truncates to 14 chars", () => {
  const result = normalizeSkuBase("This Is A Very Long Product Name");
  assert.ok(result.length <= 14);
});

test("normalizeSkuBase: empty returns ITEM", () => {
  assert.equal(normalizeSkuBase(""), "ITEM");
});

test("normalizeSkuBase: special chars become dashes", () => {
  assert.equal(normalizeSkuBase("Hierro 4.2mm"), "HIERRO-4-2MM");
});

// ── buildUniqueSku ──

test("buildUniqueSku: returns base when no conflicts", () => {
  const used = new Set();
  assert.equal(buildUniqueSku("ARENA", used), "ARENA");
});

test("buildUniqueSku: appends counter on conflict", () => {
  const used = new Set(["ARENA"]);
  assert.equal(buildUniqueSku("ARENA", used), "ARENA-01");
});

test("buildUniqueSku: increments counter for multiple conflicts", () => {
  const used = new Set(["ARENA", "ARENA-01"]);
  assert.equal(buildUniqueSku("ARENA", used), "ARENA-02");
});

// ── normalizeProvidedSku ──

test("normalizeProvidedSku: trims and uppercases", () => {
  assert.equal(normalizeProvidedSku("  abc-123  "), "ABC-123");
});

test("normalizeProvidedSku: null returns null", () => {
  assert.equal(normalizeProvidedSku(null), null);
});

test("normalizeProvidedSku: empty string returns null", () => {
  assert.equal(normalizeProvidedSku(""), null);
});

// ── normalizeSkuLookup ──

test("normalizeSkuLookup: strips non-alphanumeric", () => {
  assert.equal(normalizeSkuLookup("ABC-123"), "ABC123");
});

test("normalizeSkuLookup: strips accents", () => {
  assert.equal(normalizeSkuLookup("café"), "CAFE");
});

// ── isArchivedProductSku ──

test("isArchivedProductSku: archived prefix returns true", () => {
  assert.equal(isArchivedProductSku(`${ARCHIVED_PRODUCT_SKU_PREFIX}ABC123`), true);
});

test("isArchivedProductSku: normal SKU returns false", () => {
  assert.equal(isArchivedProductSku("ARENA-GRUESA"), false);
});

test("isArchivedProductSku: null returns false", () => {
  assert.equal(isArchivedProductSku(null), false);
});

// ── buildArchivedProductSku ──

test("buildArchivedProductSku: builds with prefix", () => {
  const result = buildArchivedProductSku("prod-123");
  assert.ok(result.startsWith(ARCHIVED_PRODUCT_SKU_PREFIX));
  assert.ok(result.includes("PROD123"));
});
