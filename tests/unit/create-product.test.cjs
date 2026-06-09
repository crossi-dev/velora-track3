const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseVeloraCommand: _parseVeloraCommand,
} = require("../../src/app/dashboard/lib/parse-velora-command.ts");
const {
  parseVeloraCommandLegacy,
} = require("../../src/app/dashboard/lib/velora-command-parser.ts");

function legacyToV2Match(c) {
  return { kind: "match", confidence: 0.5, signals: [], intent: c.intent, data: c.data };
}

function unwrapResult(r, args) {
  if (r.kind === "ambiguous") {
    return { kind: "match", confidence: r.confidence, signals: r.signals, ...r.bestGuess };
  }
  if (r.kind === "compound") {
    return { kind: "compound", commands: r.commands.map((c) => unwrapResult(c, args)) };
  }
  if (r.kind === "no-match") {
    const legacy = parseVeloraCommandLegacy(...args);
    if (legacy.matched) {
      if ("compound" in legacy) {
        return { kind: "compound", commands: legacy.commands.map(legacyToV2Match) };
      }
      return legacyToV2Match(legacy);
    }
  }
  return r;
}

function parseVeloraCommand(...args) {
  return unwrapResult(_parseVeloraCommand(...args), args);
}
const {
  buildCreateProductConfirmMessage,
} = require("../../src/app/dashboard/lib/command-parsers/create-product.ts");

const PRODUCTS = [];
const CUSTOMERS = [];

test("'nuevo producto fernet 1L a 2500' → name, price 2500, no stock", () => {
  const r = parseVeloraCommand("nuevo producto fernet 1L a 2500", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "create_product") {
    assert.equal(r.data.name, "fernet 1l");
    assert.equal(r.data.price, 2500);
    assert.equal(r.data.stock, null);
  } else {
    assert.fail("expected create_product");
  }
});

test("'agregá un producto caño hierro a 50 pesos' → name, price 50", () => {
  const r = parseVeloraCommand("agregá un producto caño hierro a 50 pesos", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "create_product") {
    assert.equal(r.data.name, "cano hierro");
    assert.equal(r.data.price, 50);
  } else {
    assert.fail("expected create_product");
  }
});

test("'nuevo producto fernet a 2500, tengo 100' → with initial stock", () => {
  const r = parseVeloraCommand("nuevo producto fernet a 2500, tengo 100", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "create_product") {
    assert.equal(r.data.name, "fernet");
    assert.equal(r.data.price, 2500);
    assert.equal(r.data.stock, 100);
  } else {
    assert.fail("expected create_product");
  }
});

test("'nuevo producto fernet precio 2500 stock 50' → precio/stock form", () => {
  const r = parseVeloraCommand("nuevo producto fernet precio 2500 stock 50", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "create_product") {
    assert.equal(r.data.name, "fernet");
    assert.equal(r.data.price, 2500);
    assert.equal(r.data.stock, 50);
  } else {
    assert.fail("expected create_product");
  }
});

test("'vendí 2 fernet a juan' → register_sale, not create_product", () => {
  const r = parseVeloraCommand("vendí 2 fernet a juan", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") {
    assert.notEqual(r.intent, "create_product");
  }
});

test("confirm message includes name, price, and stock clause when set", () => {
  const msg = buildCreateProductConfirmMessage(
    { name: "fernet 1L", price: 2500, stock: 100 },
    "ARS",
  );
  assert.ok(msg.includes("fernet 1L"));
  assert.ok(msg.includes("100"));
  assert.ok(msg.includes("stock inicial"));
});

test("confirm message omits stock clause when stock is null", () => {
  const msg = buildCreateProductConfirmMessage(
    { name: "fernet", price: 2500, stock: null },
    "ARS",
  );
  assert.ok(!msg.includes("stock inicial"));
});
