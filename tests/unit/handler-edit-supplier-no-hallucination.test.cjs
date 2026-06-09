const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleEditSupplier,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/supplier.ts");

// Regression: model-emitted `answer` ("Listo, actualicé el proveedor...") must
// never reach the chat for edit_supplier success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar la actualización...".

const SUPPLIERS = [
  { id: "sup-1", name: "Aceros del Oeste" },
  { id: "sup-2", name: "Repuestos Norte" },
];

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "edit_supplier",
    answer: "Listo, actualicé el proveedor. Ya está.",
    parsed: { intent: "edit_supplier" },
    context: {},
    fullCatalogProducts: [],
    fullCatalogCustomers: [],
    fullCatalogSuppliers: SUPPLIERS,
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

const FORBIDDEN_TOKENS = [
  /\bactualic[eé]\b/i,
  /\bactualizad[ao]\b/i,
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

test("edit_supplier success: answer is deterministic, not LLM text", () => {
  const res = handleEditSupplier(makeParams({
    text: "cambiar el teléfono de Aceros del Oeste a 2615551234",
  }));
  assert.ok(res && typeof res === "object" && "primaryAction" in res);
  assert.ok(
    /^Te paso a confirmar la actualización/i.test(res.answer),
    `answer must start with deterministic prefix; got: ${res.answer}`,
  );
  assertNoHallucination(res.answer);
});

test("edit_supplier success: answer mentions supplier and value", () => {
  const res = handleEditSupplier(makeParams({
    text: "cambiar el teléfono de Aceros del Oeste a 2615551234",
  }));
  assert.match(res.answer, /Aceros del Oeste/);
  assert.match(res.answer, /2615551234/);
  assertNoHallucination(res.answer);
});
