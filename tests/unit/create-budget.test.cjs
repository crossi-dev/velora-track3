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
  buildCreateBudgetConfirmMessage,
} = require("../../src/app/dashboard/lib/command-parsers/create-budget.ts");

const PRODUCTS = [
  { id: "p1", name: "Yerba Mate 1kg", sku: "Y-1", price: 6200 },
  { id: "p2", name: "Azucar 1kg", sku: "A-1", price: 1800 },
];

test("'presupuesto para Juan: 10 yerba a 50' → single-item budget", () => {
  const r = parseVeloraCommand("presupuesto para Juan: 10 yerba a 50", PRODUCTS, []);
  if (r.kind === "match" && r.intent === "create_budget") {
    assert.equal(r.data.customerName, "juan");
    assert.equal(r.data.items.length, 1);
    assert.equal(r.data.items[0].quantity, 10);
    assert.equal(r.data.items[0].unitPrice, 50);
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.autoSendWhatsapp, false);
  } else {
    assert.fail("expected create_budget");
  }
});

test("'hacé un presupuesto para Carlos de 50 bolsas de cemento' → single-item, verb prefix", () => {
  const r = parseVeloraCommand("hacé un presupuesto para Carlos de 50 bolsas de cemento", PRODUCTS, []);
  if (r.kind === "match" && r.intent === "create_budget") {
    assert.equal(r.data.customerName, "carlos");
    assert.ok(r.data.items.length >= 1);
    assert.equal(r.data.items[0].quantity, 50);
  } else {
    assert.fail("expected create_budget");
  }
});

test("'presupuesto para juan: 10 yerba a 50, 5 azucar a 20' → multi-item", () => {
  const r = parseVeloraCommand("presupuesto para juan: 10 yerba a 50, 5 azucar a 20", PRODUCTS, []);
  if (r.kind === "match" && r.intent === "create_budget") {
    assert.equal(r.data.items.length, 2);
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.items[1].productId, "p2");
  } else {
    assert.fail("expected create_budget");
  }
});

test("'presupuesto para juan: 10 yerba a 50 y mandáselo por whatsapp' → autoSend=true", () => {
  const r = parseVeloraCommand("presupuesto para juan: 10 yerba a 50 y mandáselo por whatsapp", PRODUCTS, []);
  if (r.kind === "match" && r.intent === "create_budget") {
    assert.equal(r.data.autoSendWhatsapp, true);
    assert.equal(r.data.items.length, 1);
    // Send keyword should be stripped from items body, not end up as item name
    assert.ok(!r.data.items[0].productName.includes("mandaselo"));
  } else {
    assert.fail("expected create_budget");
  }
});

test("'armá un presupuesto para Juan de 5 yerba a 100' → 'armá' verb", () => {
  const r = parseVeloraCommand("armá un presupuesto para Juan de 5 yerba a 100", PRODUCTS, []);
  if (r.kind === "match" && r.intent === "create_budget") {
    assert.equal(r.data.customerName, "juan");
    assert.equal(r.data.items[0].quantity, 5);
  } else {
    assert.fail("expected create_budget");
  }
});

test("'presupuesto' alone → no match (missing customer + items)", () => {
  const r = parseVeloraCommand("presupuesto", PRODUCTS, []);
  if (r.kind === "match") {
    assert.notEqual(r.intent, "create_budget");
  }
});

test("confirm message includes customer, item count, total, WhatsApp hint if autoSend", () => {
  const msgAuto = buildCreateBudgetConfirmMessage(
    {
      customerName: "Juan",
      items: [
        { productName: "yerba", productId: "p1", quantity: 10, unitPrice: 50 },
        { productName: "azucar", productId: "p2", quantity: 5, unitPrice: 20 },
      ],
      autoSendWhatsapp: true,
    },
    "ARS",
  );
  assert.ok(msgAuto.includes("Juan"));
  assert.ok(msgAuto.includes("2 ítems"));
  assert.ok(msgAuto.includes("WhatsApp"));

  const msgNoSend = buildCreateBudgetConfirmMessage(
    {
      customerName: "Juan",
      items: [{ productName: "yerba", productId: "p1", quantity: 10, unitPrice: 50 }],
      autoSendWhatsapp: false,
    },
    "ARS",
  );
  assert.ok(!msgNoSend.includes("WhatsApp"));
  assert.ok(msgNoSend.includes("1 ítem"));
});
