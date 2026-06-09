const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleRegisterMovement,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/movement.ts");

// Regression: model-emitted `answer` ("Listo, registré el movimiento...") must
// never reach the chat for register_movement success paths — the modal hasn't
// been confirmed yet. Handler overrides with a deterministic template
// "Te paso a confirmar el registro de ...".

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "register_movement",
    answer: "Listo, registré el movimiento. Ya está.",
    parsed: { intent: "register_movement", movementDraft: null },
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
  /\bregistr[eé]\b/i,
  /\bregistrad[ao]\b/i,
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

test("register_movement success: answer is deterministic, not LLM text", async () => {
  const res = handleRegisterMovement(makeParams({
    parsed: {
      intent: "register_movement",
      movementDraft: { movementType: "purchase", amount: 5000, description: "luz" },
    },
  }));
  const data = await res.json();
  assert.ok(
    /^Te paso a confirmar el registro/i.test(data.answer),
    `answer must start with deterministic prefix; got: ${data.answer}`,
  );
  assertNoHallucination(data.answer);
});

test("register_movement success: answer mentions movement type and amount", async () => {
  const res = handleRegisterMovement(makeParams({
    parsed: {
      intent: "register_movement",
      movementDraft: { movementType: "salary", amount: 50000, description: "Juan" },
    },
  }));
  const data = await res.json();
  assert.match(data.answer, /sueldo/i);
  assert.match(data.answer, /50\.?000|50,000/);
  assertNoHallucination(data.answer);
});
