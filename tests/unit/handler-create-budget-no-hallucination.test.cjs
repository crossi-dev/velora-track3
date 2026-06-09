const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleCreateBudget,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/budget.ts");

// Regression: model-emitted `answer` ("Listo, generé el presupuesto...") must
// never reach the chat for create_budget success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar el presupuesto para ...".

const PRODUCTS = [
  { id: "p1", name: "Cemento" },
  { id: "p2", name: "Arena Gruesa" },
];

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "create_budget",
    answer: "Listo, generé el presupuesto. Ya está.",
    parsed: { intent: "create_budget" },
    context: {},
    fullCatalogProducts: PRODUCTS,
    fullCatalogCustomers: [],
    fullCatalogSuppliers: [],
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

const FORBIDDEN_TOKENS = [
  /\bgener[eé]\b/i,
  /\bgenerad[ao]\b/i,
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

test("create_budget success: answer is deterministic, not LLM text", async () => {
  const res = handleCreateBudget(makeParams({
    parsed: {
      intent: "create_budget",
      budgetDraft: {
        customerName: "Juan Pérez",
        items: [
          { name: "Cemento", quantity: 5, unitPrice: 1500 },
          { name: "Arena Gruesa", quantity: 10, unitPrice: 800 },
        ],
      },
    },
  }));
  const data = await res.json();
  assert.ok(
    /^Te paso a confirmar el presupuesto/i.test(data.answer),
    `answer must start with deterministic prefix; got: ${data.answer}`,
  );
  assertNoHallucination(data.answer);
});

test("create_budget success: answer mentions customer and total", async () => {
  const res = handleCreateBudget(makeParams({
    parsed: {
      intent: "create_budget",
      budgetDraft: {
        customerName: "Juan Pérez",
        items: [{ name: "Cemento", quantity: 2, unitPrice: 1500 }],
      },
    },
  }));
  const data = await res.json();
  assert.match(data.answer, /Juan Pérez/);
  assert.match(data.answer, /3\.?000|3,000/);
  assertNoHallucination(data.answer);
});
