const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleReportEvent,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/event-report.ts");

// Regression: model-emitted `answer` may include hallucinated specifics
// ("Listo, anoté la queja de Juan sobre el envío") that don't match what
// was actually published. Handler returns a deterministic "Anotado..." reply.

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "report_event",
    answer: "Listo, anoté el incidente. Ya está.",
    parsed: { intent: "report_event" },
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
  /\banot[eé]\b/i,
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

test("report_event with eventType: deterministic 'Anotado: ...' answer", () => {
  const res = handleReportEvent(makeParams({
    parsed: {
      intent: "report_event",
      eventReport: { eventType: "incidente", details: "se cayó el cartel" },
    },
  }));
  assert.ok(res);
  assert.match(res.answer, /^Anotado/);
  assertNoHallucination(res.answer);
});

test("report_event without eventType or details: falls back to deterministic, ignores model answer", () => {
  const res = handleReportEvent(makeParams({
    parsed: { intent: "report_event" },
  }));
  assert.ok(res);
  assert.match(res.answer, /^Anotado/);
  assertNoHallucination(res.answer);
});
