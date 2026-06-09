const assert = require("node:assert/strict");
const test = require("node:test");

const {
  matchProductByName,
} = require("../../src/app/api/business-assistant/_lib/match-product-by-name.ts");

const CATALOG = [
  { id: "p1", name: "Arena Gruesa Premium" },
  { id: "p2", name: "Arena Fina" },
  { id: "p3", name: "Clavo 2 pulgadas" },
  { id: "p4", name: "Filtro Bosch" },
  { id: "p5", name: "Papas" },
  { id: "p6", name: "Sandías" },
];

// ── Exact match ──────────────────────────────────────────────────────

test("exact case-insensitive match wins", () => {
  assert.equal(matchProductByName("arena fina", CATALOG)?.id, "p2");
  assert.equal(matchProductByName("PAPAS", CATALOG)?.id, "p5");
});

// ── Substring match ──────────────────────────────────────────────────

test("query is catalog substring (model returned 'arena')", () => {
  const m = matchProductByName("arena", CATALOG);
  // prefers longest catalog match
  assert.ok(m);
  assert.equal(m?.id, "p1");
});

test("catalog name is substring of query", () => {
  const m = matchProductByName("clavo 2 pulgadas grandes", CATALOG);
  assert.equal(m?.id, "p3");
});

test("accent-insensitive substring match", () => {
  assert.equal(matchProductByName("sandias", CATALOG)?.id, "p6");
});

// ── Levenshtein fallback ─────────────────────────────────────────────

test("typo within threshold (papa → Papas)", () => {
  const m = matchProductByName("papa", CATALOG);
  assert.equal(m?.id, "p5");
});

test("typo one-char off for longer name", () => {
  const m = matchProductByName("filtro bosh", CATALOG);
  assert.equal(m?.id, "p4");
});

// ── Negative cases ───────────────────────────────────────────────────

test("single-char query → null", () => {
  assert.equal(matchProductByName("a", CATALOG), null);
});

test("empty query → null", () => {
  assert.equal(matchProductByName("", CATALOG), null);
});

test("empty catalog → null", () => {
  assert.equal(matchProductByName("arena", []), null);
});

test("unrelated text → null", () => {
  assert.equal(matchProductByName("zapato", CATALOG), null);
});

test("two-char query that is not exact match → null", () => {
  // "ar" is substring of "arena" but <3 chars, so substring matching skipped;
  // Levenshtein too far → null
  assert.equal(matchProductByName("ar", CATALOG), null);
});
