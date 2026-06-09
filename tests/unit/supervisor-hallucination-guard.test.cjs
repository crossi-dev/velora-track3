const assert = require("node:assert/strict");
const test = require("node:test");

const {
  applySupervisorHallucinationGuard,
} = require("../../src/app/api/supervisor/_lib/supervisor-hallucination-guard.ts");

const {
  HALLUCINATION_FALLBACK_ANSWER,
} = require("../../src/app/api/business-assistant/_lib/answer-hallucination-guard.ts");

function reset() {
  delete process.env.HALLUCINATION_GUARD_MODE;
}

// ── Shadow mode (default) ────────────────────────────────────────────

test("shadow mode: matched answer is NOT modified", () => {
  // shadow mode must be explicitly opted in; enforce is the default.
  process.env.HALLUCINATION_GUARD_MODE = "shadow";
  const parsed = {
    kind: "answer",
    answer: "Listo, registrada la venta de 1 yerba.",
    actions: null,
    clarification: null,
    notification: null,
  };
  const result = applySupervisorHallucinationGuard(parsed, {});
  assert.equal(result.answer, parsed.answer, "shadow must leave answer untouched");
  reset();
});

test("shadow mode: clean answer passes through unchanged", () => {
  reset();
  const parsed = {
    kind: "answer",
    answer: "Hoy vendiste 3 yerbas por $3600.",
    actions: null,
    clarification: null,
    notification: null,
  };
  const result = applySupervisorHallucinationGuard(parsed, {});
  assert.equal(result.answer, parsed.answer);
});

// ── Enforce mode ──────────────────────────────────────────────────────

test("enforce mode: matched answer is replaced with fallback", () => {
  process.env.HALLUCINATION_GUARD_MODE = "enforce";
  const parsed = {
    kind: "answer",
    answer: "Listo, registrada la venta.",
    actions: null,
    clarification: null,
    notification: null,
  };
  const result = applySupervisorHallucinationGuard(parsed, {});
  assert.equal(result.answer, HALLUCINATION_FALLBACK_ANSWER);
  delete process.env.HALLUCINATION_GUARD_MODE;
});

test("enforce mode: clean answer passes through unchanged", () => {
  process.env.HALLUCINATION_GUARD_MODE = "enforce";
  const parsed = {
    kind: "answer",
    answer: "Te quedan 12 unidades de yerba.",
    actions: null,
    clarification: null,
    notification: null,
  };
  const result = applySupervisorHallucinationGuard(parsed, {});
  assert.equal(result.answer, parsed.answer);
  delete process.env.HALLUCINATION_GUARD_MODE;
});

// ── kind:"actions" — answer field is now guarded ────────────────────

test("kind=actions enforce (default): hallucinated answer IS replaced, actions intact", () => {
  // enforce is the default (no env var set) — HALLUCINATION_GUARD_MODE docs say enforce.
  reset();
  const parsed = {
    kind: "actions",
    answer: "Listo, actualicé el precio.",
    actions: [{ intent: "edit_product", data: {}, summary: "" }],
    clarification: null,
    notification: null,
  };
  const result = applySupervisorHallucinationGuard(parsed, {});
  assert.notEqual(result.answer, parsed.answer, "enforce must replace hallucinated actions answer");
  assert.deepEqual(result.actions, parsed.actions, "actions array must remain intact");
});

test("kind=actions enforce: hallucinated answer replaced, actions intact", () => {
  process.env.HALLUCINATION_GUARD_MODE = "enforce";
  const parsed = {
    kind: "actions",
    answer: "Listo, actualicé el precio.",
    actions: [{ intent: "edit_product", data: {}, summary: "" }],
    clarification: null,
    notification: null,
  };
  const result = applySupervisorHallucinationGuard(parsed, {});
  assert.notEqual(result.answer, parsed.answer, "enforce must replace hallucinated answer");
  assert.ok(
    !result.answer.match(/listo|registrad[ao]|confirmad[ao]|quedó|quedaron|se hizo/i),
    "replacement must not contain past-tense success language",
  );
  assert.deepEqual(result.actions, parsed.actions, "actions array must remain intact");
  delete process.env.HALLUCINATION_GUARD_MODE;
});

test("kind=actions enforce: clean answer passes through unchanged", () => {
  process.env.HALLUCINATION_GUARD_MODE = "enforce";
  const parsed = {
    kind: "actions",
    answer: "Voy a actualizar el precio.",
    actions: [{ intent: "edit_product", data: {}, summary: "" }],
    clarification: null,
    notification: null,
  };
  const result = applySupervisorHallucinationGuard(parsed, {});
  assert.equal(result.answer, parsed.answer, "clean actions answer must not be replaced");
  delete process.env.HALLUCINATION_GUARD_MODE;
});

test("kind=clarification: guard does not act", () => {
  process.env.HALLUCINATION_GUARD_MODE = "enforce";
  const parsed = {
    kind: "clarification",
    answer: "",
    actions: null,
    clarification: { question: "¿A qué cliente?", context: "" },
    notification: null,
  };
  const result = applySupervisorHallucinationGuard(parsed, {});
  assert.deepEqual(result, parsed);
  reset();
});

// ── Edge cases ──────────────────────────────────────────────────────

test("empty answer is passthrough (no log noise)", () => {
  process.env.HALLUCINATION_GUARD_MODE = "enforce";
  const parsed = {
    kind: "answer",
    answer: "",
    actions: null,
    clarification: null,
    notification: null,
  };
  const result = applySupervisorHallucinationGuard(parsed, {});
  assert.equal(result.answer, "");
  reset();
});
