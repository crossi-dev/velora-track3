const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleCreateSupplier,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/supplier.ts");

// Regression: model-emitted `answer` ("Listo, agregué el proveedor...") must
// never reach the chat for create_supplier success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar el alta del proveedor...".

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "create_supplier",
    answer: "Listo, agregué el proveedor. Ya está.",
    parsed: { intent: "create_supplier" },
    context: {},
    fullCatalogProducts: [],
    fullCatalogCustomers: [],
    fullCatalogSuppliers: [],
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

const FORBIDDEN_TOKENS = [
  /\bagregu[eé]\b/i,
  /\bagregad[ao]\b/i,
  /\bcread[ao]\b/i,
  /\bya está\b/i,
  /\blisto\b/i,
];

function assertNoHallucination(answer) {
  for (const re of FORBIDDEN_TOKENS) {
    assert.ok(
      !re.test(answer),
      `answer must not contain past-tense action token ${re}; got: ${answer}`,
    );
  }
}

test("create_supplier success: answer is deterministic, not LLM text", () => {
  const res = handleCreateSupplier(makeParams({
    text: "agregá un proveedor llamado Distribuidora ABC",
    parsed: {
      intent: "create_supplier",
      supplier: { name: "Distribuidora ABC" },
    },
  }));
  assert.ok(res && typeof res === "object" && "primaryAction" in res);
  assert.ok(
    /^Te paso a confirmar el alta del proveedor/i.test(res.answer),
    `answer must start with deterministic prefix; got: ${res.answer}`,
  );
  assertNoHallucination(res.answer);
});

test("create_supplier success: answer mentions supplier name", () => {
  const res = handleCreateSupplier(makeParams({
    text: "nuevo proveedor Distribuidora ABC",
    parsed: {
      intent: "create_supplier",
      supplier: { name: "Distribuidora ABC" },
    },
  }));
  assert.match(res.answer, /Distribuidora ABC/);
  assertNoHallucination(res.answer);
});
