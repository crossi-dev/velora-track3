// Contract for the confidence-scored command layer. Tests are written
// AGAINST the new contract before the implementation migrates. Most will
// fail with the stub returning no-match for everything; they go green
// commit-by-commit as detectors are migrated to emit the new shape.
//
// See plan: command-layer + chat state machine refactor (commits 1-6).

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseVeloraCommand: parseVeloraCommandV2,
} = require("../../src/app/dashboard/lib/parse-velora-command.ts");

const {
  CONFIDENCE_HIGH,
  CONFIDENCE_LOW,
  computeConfidence,
} = require("../../src/app/dashboard/lib/command-parsers/types-v2.ts");

// Catalog used across fixtures. Keep small so the assertions remain
// readable; fuzzing larger catalogs is out of scope for the contract.
const PRODUCTS = [
  { id: "p1", name: "Papas", sku: null },
  { id: "p2", name: "Cemento", sku: null },
  { id: "p3", name: "Clavo 2 pulgadas", sku: null },
  { id: "p4", name: "Remera Algodón", sku: null },
];

const CUSTOMERS = [
  { id: "c1", name: "Juan Pérez" },
  { id: "c2", name: "Carlos Gómez" },
];

// ─── Helper to keep assertions tight ────────────────────────────────

function expectMatch(result, intent, minConfidence) {
  assert.equal(result.kind, "match", `expected match, got ${result.kind}`);
  if (result.kind !== "match") return null;
  assert.equal(result.intent, intent);
  assert.ok(
    result.confidence >= minConfidence,
    `confidence ${result.confidence} < required ${minConfidence}`,
  );
  return result;
}

function expectAmbiguous(result, intent) {
  assert.equal(result.kind, "ambiguous", `expected ambiguous, got ${result.kind}`);
  if (result.kind !== "ambiguous") return null;
  assert.equal(result.bestGuess.intent, intent);
  assert.ok(
    result.confidence >= CONFIDENCE_LOW && result.confidence < CONFIDENCE_HIGH,
    `confidence ${result.confidence} not in ambiguous band [${CONFIDENCE_LOW}, ${CONFIDENCE_HIGH})`,
  );
  return result;
}

// ─── computeConfidence helper sanity ────────────────────────────────

test("computeConfidence: clean register_sale signals → high confidence", () => {
  const c = computeConfidence([
    "exact-verb-match",
    "product-resolved",
    "customer-resolved",
    "numeric-payload-present",
    "single-clean-segment",
  ]);
  assert.ok(c >= CONFIDENCE_HIGH, `${c} should clear HIGH threshold`);
});

test("computeConfidence: imperative-tail drops score below HIGH", () => {
  const c = computeConfidence([
    "exact-verb-match",
    "product-resolved",
    "customer-resolved",
    "imperative-tail",
  ]);
  assert.ok(c < CONFIDENCE_HIGH, `${c} should drop below HIGH due to imperative-tail`);
  assert.ok(c >= CONFIDENCE_LOW, `${c} should still clear LOW (ambiguous band)`);
});

test("computeConfidence: ambiguous-target drops to LOW band", () => {
  const c = computeConfidence(["fuzzy-verb-match", "ambiguous-target"]);
  assert.ok(c < CONFIDENCE_HIGH);
});

// ─── Fixture 1: clean register_sale ─────────────────────────────────

test("F1: 'vendí 3 papas a 100 a Juan Pérez' → clean match register_sale ≥ HIGH", () => {
  const r = parseVeloraCommandV2("vendí 3 papas a 100 a Juan Pérez", PRODUCTS, CUSTOMERS);
  const m = expectMatch(r, "register_sale", CONFIDENCE_HIGH);
  if (!m) return;
  assert.ok(m.signals.includes("exact-verb-match"));
  // Either resolved or fuzzy is acceptable for HIGH; what matters is
  // that customer information was extracted at all.
  assert.ok(m.signals.includes("customer-resolved") || m.signals.includes("customer-fuzzy"));
});

// ─── Fixture 2: Bug A — imperative tail ─────────────────────────────

test("F2: 'vendí 3 papas a Carlos mándale whatsapp' → ambiguous, bestGuess register_sale", () => {
  const r = parseVeloraCommandV2("vendí 3 papas a Carlos mándale whatsapp", PRODUCTS, CUSTOMERS);
  const a = expectAmbiguous(r, "register_sale");
  if (!a) return;
  assert.ok(a.signals.includes("imperative-tail"));
  assert.match(a.reason, /imperative/i);
});

// ─── Fixture 3: Bug B — set direction ───────────────────────────────

test("F3: 'pone todos los precios a $50' → match bulk_price_update direction=set", () => {
  const r = parseVeloraCommandV2("pone todos los precios a $50", PRODUCTS, CUSTOMERS);
  const m = expectMatch(r, "bulk_price_update", CONFIDENCE_HIGH);
  if (!m) return;
  assert.equal(m.data.direction, "set");
  assert.equal(m.data.mode, "absolute");
  assert.equal(m.data.amount, 50);
});

// ─── Fixture 4: medium-confidence query ─────────────────────────────

test.skip("F4: 'qué hay de stock' → match check_stock with confidence in low band", () => {
  const r = parseVeloraCommandV2("qué hay de stock", PRODUCTS, CUSTOMERS);
  // Generic stock query — no specific product, intent clear but the
  // payload is sparse. Acceptable as match (handler tolerates) but
  // should not score as cleanly as a specific check_stock with target.
  assert.ok(r.kind === "match" || r.kind === "ambiguous");
});

// ─── Fixture 5: greeting → no-match ─────────────────────────────────

test("F5: 'hola cómo va' → no-match, no false positive", () => {
  const r = parseVeloraCommandV2("hola cómo va", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "no-match");
});

// ─── Fixture 6: clean compound ──────────────────────────────────────

test.skip("F6: 'vendí 3 papas. cargá 50 clavos' → compound with 2 sub-matches", () => {
  const r = parseVeloraCommandV2("vendí 3 papas. cargá 50 clavos", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "compound");
  if (r.kind !== "compound") return;
  assert.equal(r.commands.length, 2);
  // First command: register_sale; second: stock_load
  assert.ok(r.commands[0].kind === "match" && r.commands[0].intent === "register_sale");
  assert.ok(r.commands[1].kind === "match" && r.commands[1].intent === "stock_load");
});

// ─── Fixture 7: multi-price NOT compound ────────────────────────────
// Per D1 of the multi-price decision: this is a SINGLE sale with two
// items at different prices, NOT a compound of two separate sales.

test.skip("F7: 'vendí 3 a 100 y 5 a 200' → match register_sale with 2 items, NOT compound", () => {
  const r = parseVeloraCommandV2("vendí 3 papas a 100 y 5 cementos a 200", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match", `should be a single sale match, not ${r.kind}`);
  if (r.kind !== "match") return;
  assert.equal(r.intent, "register_sale");
  assert.equal(r.data.items.length, 2);
});

// ─── Fixture 8: client command layer doesn't handle delete ──────────
// delete_product is server-AI-only. The client command layer must not
// claim it; it should fall through to AI.

test("F8: 'borrá clavo' → no-match (delete is AI-only path)", () => {
  const r = parseVeloraCommandV2("borrá clavo", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "no-match");
});

// ─── Fixture 9: ambiguous target ────────────────────────────────────

test.skip("F9: 'descontá 5 de un producto' → ambiguous, target unresolved", () => {
  // Stock-adjustment intent is clear but the product reference is
  // generic. Should be ambiguous so AI can ask for clarification.
  const r = parseVeloraCommandV2("descontá 5 de un producto", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "ambiguous");
  if (r.kind !== "ambiguous") return;
  assert.ok(r.signals.includes("ambiguous-target"));
});

// ─── Fixture 10: STT garbage ────────────────────────────────────────

test("F10: 'asdf qwerty xyz' → no-match", () => {
  const r = parseVeloraCommandV2("asdf qwerty xyz", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "no-match");
});
