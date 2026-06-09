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
  buildRegisterMovementConfirmMessage,
} = require("../../src/app/dashboard/lib/command-parsers/register-movement.ts");

const PRODUCTS = [];
const CUSTOMERS = [];

// ── Expense patterns ───────────────────────────────────────────────

test("'gasto de 3000 en luz' → purchase, 3000, luz", () => {
  const r = parseVeloraCommand("gasto de 3000 en luz", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_movement") {
    assert.equal(r.data.movementType, "purchase");
    assert.equal(r.data.amount, 3000);
    assert.equal(r.data.description, "luz");
  } else {
    assert.fail("expected register_movement");
  }
});

test("'gasté 5000 en limpieza' → purchase, 5000", () => {
  const r = parseVeloraCommand("gasté 5000 en limpieza", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_movement") {
    assert.equal(r.data.movementType, "purchase");
    assert.equal(r.data.amount, 5000);
  } else {
    assert.fail("expected register_movement");
  }
});

test("'pagué 8000 de alquiler' → purchase, 8000, alquiler", () => {
  const r = parseVeloraCommand("pagué 8000 de alquiler", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_movement") {
    assert.equal(r.data.movementType, "purchase");
    assert.equal(r.data.amount, 8000);
    assert.equal(r.data.description, "alquiler");
  } else {
    assert.fail("expected register_movement");
  }
});

test("'anotá un gasto de 5000 en papelería' → purchase with request prefix", () => {
  const r = parseVeloraCommand("anotá un gasto de 5000 en papelería", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_movement") {
    assert.equal(r.data.movementType, "purchase");
    assert.equal(r.data.amount, 5000);
    assert.equal(r.data.description, "papeleria");
  } else {
    assert.fail("expected register_movement");
  }
});

// ── Income patterns ────────────────────────────────────────────────

test("'cobré 15000 de servicio' → income, 15000, servicio", () => {
  const r = parseVeloraCommand("cobré 15000 de servicio", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_movement") {
    assert.equal(r.data.movementType, "income");
    assert.equal(r.data.amount, 15000);
    assert.equal(r.data.description, "servicio");
  } else {
    assert.fail("expected register_movement");
  }
});

test("'ingreso de 20000 por alquiler cobrado' → income", () => {
  const r = parseVeloraCommand("ingreso de 20000 por alquiler cobrado", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_movement") {
    assert.equal(r.data.movementType, "income");
    assert.equal(r.data.amount, 20000);
  } else {
    assert.fail("expected register_movement");
  }
});

// ── Category overrides ─────────────────────────────────────────────

test("'pagué 15000 de impuesto' → tax (tax keyword overrides purchase)", () => {
  const r = parseVeloraCommand("pagué 15000 de impuesto", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_movement") {
    assert.equal(r.data.movementType, "tax");
  } else {
    assert.fail("expected register_movement");
  }
});

test("'pagué 50000 de sueldo' → salary", () => {
  const r = parseVeloraCommand("pagué 50000 de sueldo", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_movement") {
    assert.equal(r.data.movementType, "salary");
  } else {
    assert.fail("expected register_movement");
  }
});

test("'pagué 3000 de iva' → tax", () => {
  const r = parseVeloraCommand("pagué 3000 de iva", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_movement") {
    assert.equal(r.data.movementType, "tax");
  } else {
    assert.fail("expected register_movement");
  }
});

// ── Negative cases ─────────────────────────────────────────────────

test("'hola' → no match", () => {
  const r = parseVeloraCommand("hola", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "no-match");
});

test("'vendí 2 yerbas' → register_sale not register_movement", () => {
  const r = parseVeloraCommand("vendí 2 yerbas", [{ id: "p1", name: "Yerba", price: 100 }], CUSTOMERS);
  if (r.kind === "match") {
    assert.notEqual(r.intent, "register_movement");
  }
});

// ── Confirm message builder ────────────────────────────────────────

test("confirm message for purchase uses 'gasto' label and currency", () => {
  const msg = buildRegisterMovementConfirmMessage(
    { movementType: "purchase", amount: 3000, description: "luz" },
    "ARS",
  );
  assert.ok(msg.includes("gasto"));
  assert.ok(msg.includes("luz"));
  assert.ok(msg.startsWith("¿Registrar"));
});

test("confirm message for salary uses 'sueldo' label", () => {
  const msg = buildRegisterMovementConfirmMessage(
    { movementType: "salary", amount: 50000, description: "empleado" },
    "ARS",
  );
  assert.ok(msg.includes("sueldo"));
});

test("confirm message for income uses 'ingreso' label", () => {
  const msg = buildRegisterMovementConfirmMessage(
    { movementType: "income", amount: 5000, description: "servicio" },
    "ARS",
  );
  assert.ok(msg.includes("ingreso"));
});
