const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getProductCandidates,
} = require("../../src/app/api/business-assistant/_lib/handlers/product-candidates.ts");

const CATALOG = [
  { id: "p1", name: "Papa Blanca" },
  { id: "p2", name: "Papa Ñoqui" },
  { id: "p3", name: "Papa Gris" },
  { id: "p4", name: "Arena Gruesa" },
  { id: "p5", name: "Arena Fina" },
  { id: "p6", name: "Martillo Stanley 500g" },
  { id: "p7", name: "Filtro Bosch" },
];

test("returns top 3 candidates for ambiguous 'papa'", () => {
  const result = getProductCandidates("papa", CATALOG);
  assert.equal(result.length, 3);
  const names = result.map((r) => r.name);
  assert.ok(names.every((n) => n.toLowerCase().includes("papa")));
});

test("respects limit parameter", () => {
  const result = getProductCandidates("papa", CATALOG, 2);
  assert.equal(result.length, 2);
});

test("ranks exact substring over Levenshtein", () => {
  const result = getProductCandidates("arena", CATALOG);
  assert.equal(result.length, 2);
  assert.ok(result.every((r) => r.name.toLowerCase().includes("arena")));
});

test("includes accent-insensitive match", () => {
  const result = getProductCandidates("papa noqui", CATALOG);
  assert.ok(result.some((r) => r.name === "Papa Ñoqui"));
});

test("typo tolerance via Levenshtein", () => {
  const result = getProductCandidates("martlio", CATALOG);
  // not exact, not substring, but Levenshtein should catch
  assert.ok(result.some((r) => r.name.toLowerCase().includes("martillo")));
});

test("empty query → empty", () => {
  assert.deepEqual(getProductCandidates("", CATALOG), []);
});

test("empty catalog → empty", () => {
  assert.deepEqual(getProductCandidates("papa", []), []);
});

test("unrelated query → empty", () => {
  assert.deepEqual(getProductCandidates("xyzzy", CATALOG), []);
});

test("single char query → empty", () => {
  assert.deepEqual(getProductCandidates("a", CATALOG), []);
});

test("exact match scored highest", () => {
  const catalog = [
    { id: "p1", name: "Arena" },
    { id: "p2", name: "Arena Gruesa Premium" },
  ];
  const result = getProductCandidates("arena", catalog);
  assert.equal(result[0].name, "Arena");
});

test("cross-word match on full sentence query", () => {
  const result = getProductCandidates("cuanto vale la arena gruesa", CATALOG);
  assert.ok(result.length > 0);
  assert.equal(result[0].name, "Arena Gruesa");
});

test("stopwords filtered out", () => {
  // Query has many stopwords; should still match Filtro Bosch
  const result = getProductCandidates("dame el precio del filtro bosch", CATALOG);
  assert.ok(result.some((r) => r.name === "Filtro Bosch"));
});
