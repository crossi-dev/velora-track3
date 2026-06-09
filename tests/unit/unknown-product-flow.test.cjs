const assert = require("node:assert/strict");
const test = require("node:test");

const {
  _resetPendingUnknownProductForTests,
  buildUnknownProductQuestion,
  clearPendingUnknownProduct,
  getPendingUnknownProduct,
  parsePriceResponse,
  setPendingUnknownProduct,
} = require("../../src/app/dashboard/lib/unknown-product-flow.ts");

const {
  parseVeloraCommand: _parseVeloraCommand,
} = require("../../src/app/dashboard/lib/parse-velora-command.ts");
const {
  parseVeloraCommandLegacy,
} = require("../../src/app/dashboard/lib/velora-command-parser.ts");

function legacyToV2Match(c) {
  return { kind: "match", confidence: 0.5, signals: [], intent: c.intent, data: c.data };
}

function parseVeloraCommand(...args) {
  // Bypass v2 to avoid double-calling legacy (which would consume mutable
  // pending state twice). Tests target legacy parser behavior; v2 confidence
  // scoring is covered by command-layer-confidence.test.cjs.
  const legacy = parseVeloraCommandLegacy(...args);
  if (!legacy.matched) return { kind: "no-match" };
  if ("compound" in legacy) {
    return { kind: "compound", commands: legacy.commands.map(legacyToV2Match) };
  }
  return legacyToV2Match(legacy);
}

// ── Pending state basics ───────────────────────────────────────────

test("no pending → getPendingUnknownProduct returns null", () => {
  _resetPendingUnknownProductForTests();
  assert.equal(getPendingUnknownProduct(), null);
});

test("set → get round-trip returns the data plus a timestamp", () => {
  _resetPendingUnknownProductForTests();
  setPendingUnknownProduct({ productName: "fernet", saleText: "vendí 2 fernet a juan" });
  const p = getPendingUnknownProduct();
  assert.ok(p);
  assert.equal(p.productName, "fernet");
  assert.equal(p.saleText, "vendí 2 fernet a juan");
  assert.ok(typeof p.timestamp === "number");
});

test("clearPendingUnknownProduct wipes the state", () => {
  _resetPendingUnknownProductForTests();
  setPendingUnknownProduct({ productName: "fernet", saleText: "x" });
  clearPendingUnknownProduct();
  assert.equal(getPendingUnknownProduct(), null);
});

// ── Price response parser ──────────────────────────────────────────

test("bare integer → price parsed", () => {
  assert.equal(parsePriceResponse("2500"), 2500);
});

test("'$2500' → 2500", () => {
  assert.equal(parsePriceResponse("$2500"), 2500);
});

test("'2500 pesos' → 2500", () => {
  assert.equal(parsePriceResponse("2500 pesos"), 2500);
});

test("'a 2500' / 'por 2500' / 'en 2500' all parse", () => {
  assert.equal(parsePriceResponse("a 2500"), 2500);
  assert.equal(parsePriceResponse("por 2500"), 2500);
  assert.equal(parsePriceResponse("en 2500"), 2500);
});

test("non-numeric input → null (caller falls through to AI)", () => {
  assert.equal(parsePriceResponse("no sé"), null);
  assert.equal(parsePriceResponse("barato"), null);
  assert.equal(parsePriceResponse(""), null);
});

test("zero or negative → null", () => {
  assert.equal(parsePriceResponse("0"), null);
});

// ── Question builder ───────────────────────────────────────────────

test("buildUnknownProductQuestion embeds the product name in quotes", () => {
  const q = buildUnknownProductQuestion("fernet 1L");
  assert.ok(q.includes('"fernet 1L"'));
  assert.ok(q.includes("precio"));
});

// ── Parser integration: bare price wins when pending is active ─────

test("pending + bare price reply → create_product_from_voice intent", () => {
  _resetPendingUnknownProductForTests();
  setPendingUnknownProduct({ productName: "fernet", saleText: "vendí 2 fernet a juan" });
  const r = parseVeloraCommand("2500", [], []);
  if (r.kind === "match" && r.intent === "create_product_from_voice") {
    assert.equal(r.data.productName, "fernet");
    assert.equal(r.data.price, 2500);
    assert.equal(r.data.retrySaleText, "vendí 2 fernet a juan");
  } else {
    assert.fail("expected create_product_from_voice");
  }
});

test("pending state is consumed after price parse (subsequent calls → null)", () => {
  _resetPendingUnknownProductForTests();
  setPendingUnknownProduct({ productName: "fernet", saleText: "x" });
  parseVeloraCommand("2500", [], []);
  assert.equal(getPendingUnknownProduct(), null);
});

test("pending + non-numeric reply → state preserved (AI can continue)", () => {
  _resetPendingUnknownProductForTests();
  setPendingUnknownProduct({ productName: "fernet", saleText: "x" });
  parseVeloraCommand("no sé", [], []);
  // State not consumed because no price matched — user can retry.
  assert.ok(getPendingUnknownProduct());
});

test("no pending + bare '2500' → no match (other intents can handle)", () => {
  _resetPendingUnknownProductForTests();
  const r = parseVeloraCommand("2500", [], []);
  if (r.kind === "match") {
    assert.notEqual(r.intent, "create_product_from_voice");
  }
});
