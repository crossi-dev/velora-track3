// Unit tests for the server-side confirmation-response detector. The
// detector turns "sí" / "no" / "ok" / "cancelar" into a yes/no answer
// when a confirmationRequest is pending, so the chat pipeline can
// short-circuit Gemini Pro/Flash (4-8s) and resolve a 1-bit answer in <50ms.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectConfirmationAnswer,
} = require("../../src/app/api/business-assistant/_lib/nlu/confirmation-response.ts");

const {
  getPendingConfirmation,
} = require("../../src/app/api/business-assistant/_lib/nlu/pending-confirmation.ts");

// ── yes ──────────────────────────────────────────────────────────────

test("yes: bare affirmations", () => {
  for (const t of ["si", "sí", "ok", "dale", "listo", "bueno", "confirmo", "perfecto", "va", "sale", "claro", "obvio"]) {
    assert.equal(detectConfirmationAnswer(t), "yes", `expected yes for '${t}'`);
  }
});

test("yes: accent variants", () => {
  assert.equal(detectConfirmationAnswer("sí"), "yes");
  assert.equal(detectConfirmationAnswer("si"), "yes");
});

test("yes: capitalization tolerated", () => {
  assert.equal(detectConfirmationAnswer("Si"), "yes");
  assert.equal(detectConfirmationAnswer("DALE"), "yes");
  assert.equal(detectConfirmationAnswer("Confirmo"), "yes");
});

test("yes: trailing punctuation tolerated", () => {
  assert.equal(detectConfirmationAnswer("dale!"), "yes");
  assert.equal(detectConfirmationAnswer("sí."), "yes");
  assert.equal(detectConfirmationAnswer("ok."), "yes");
  assert.equal(detectConfirmationAnswer("perfecto!!"), "yes");
});

test("yes: whitespace tolerated", () => {
  assert.equal(detectConfirmationAnswer("  sí  "), "yes");
  assert.equal(detectConfirmationAnswer("\tok\n"), "yes");
});

test("yes: short multi-word affirmations", () => {
  assert.equal(detectConfirmationAnswer("ok dale"), "yes");
  assert.equal(detectConfirmationAnswer("dale ok"), "yes");
  assert.equal(detectConfirmationAnswer("si si"), "yes");
});

test("yes: filler-word combos (common in AR Spanish chat)", () => {
  assert.equal(detectConfirmationAnswer("sí, dale"), "yes");
  assert.equal(detectConfirmationAnswer("sí confirmá"), "yes");
  assert.equal(detectConfirmationAnswer("ok confirmá"), "yes");
  assert.equal(detectConfirmationAnswer("sí listo"), "yes");
  assert.equal(detectConfirmationAnswer("sí sale"), "yes");
  assert.equal(detectConfirmationAnswer("sí ok"), "yes");
});

// ── no ───────────────────────────────────────────────────────────────

test("no: bare negations", () => {
  for (const t of ["no", "nope", "cancelar", "cancel", "abortar", "parar"]) {
    assert.equal(detectConfirmationAnswer(t), "no", `expected no for '${t}'`);
  }
});

test("no: accented variants", () => {
  assert.equal(detectConfirmationAnswer("cancelá"), "no");
  assert.equal(detectConfirmationAnswer("pará"), "no");
  assert.equal(detectConfirmationAnswer("dejá"), "no");
});

test("no: capitalization and punctuation tolerated", () => {
  assert.equal(detectConfirmationAnswer("NO"), "no");
  assert.equal(detectConfirmationAnswer("No."), "no");
  assert.equal(detectConfirmationAnswer("Cancelar!"), "no");
});

test("no: multi-word negations", () => {
  assert.equal(detectConfirmationAnswer("mejor no"), "no");
  assert.equal(detectConfirmationAnswer("no gracias"), "no");
  assert.equal(detectConfirmationAnswer("ni en pedo"), "no");
  assert.equal(detectConfirmationAnswer("no, cancelá"), "no");
  assert.equal(detectConfirmationAnswer("no cancel"), "no");
});

// ── ambiguous / null ─────────────────────────────────────────────────

test("null: compound messages with extra intent", () => {
  assert.equal(detectConfirmationAnswer("sí, pero cambiá el monto"), null);
  assert.equal(detectConfirmationAnswer("ok cargá 5 clavos"), null);
  assert.equal(detectConfirmationAnswer("no, mejor vendele otra cosa"), null);
  assert.equal(detectConfirmationAnswer("cancela y vendele 3 papas"), null);
  assert.equal(detectConfirmationAnswer("sí, vendi otra"), null);
  assert.equal(detectConfirmationAnswer("si pero cambia el precio"), null);
});

test("null: empty / whitespace / unrelated", () => {
  assert.equal(detectConfirmationAnswer(""), null);
  assert.equal(detectConfirmationAnswer("   "), null);
  assert.equal(detectConfirmationAnswer("hola"), null);
  assert.equal(detectConfirmationAnswer("no me acuerdo"), null);
});

test("null: long messages", () => {
  assert.equal(detectConfirmationAnswer("si si si si si si si si si"), null);
  assert.equal(detectConfirmationAnswer("dale confirmalo por favor"), null);
});

test("null: non-string input", () => {
  assert.equal(detectConfirmationAnswer(null), null);
  assert.equal(detectConfirmationAnswer(undefined), null);
  assert.equal(detectConfirmationAnswer(123), null);
});

// ── exclusivity ──────────────────────────────────────────────────────

test("yes and no are mutually exclusive", () => {
  const samples = ["sí", "ok", "dale", "perfecto", "no", "cancelar", "nope", "mejor no", "no gracias"];
  for (const s of samples) {
    const ans = detectConfirmationAnswer(s);
    assert.notEqual(ans, null, `'${s}' should match yes or no`);
    // each token belongs to exactly one family
    assert.ok(ans === "yes" || ans === "no", `'${s}' must be yes or no, got ${ans}`);
  }
});

// ── getPendingConfirmation ───────────────────────────────────────────

test("getPendingConfirmation: returns null for empty/undefined history", () => {
  assert.equal(getPendingConfirmation(undefined), null);
  assert.equal(getPendingConfirmation([]), null);
});

test("getPendingConfirmation: returns null when last assistant turn has no card", () => {
  const history = [
    { role: "user", text: "vendí 3 cocas" },
    { role: "assistant", text: "Listo, registré la venta." },
  ];
  assert.equal(getPendingConfirmation(history), null);
});

test("getPendingConfirmation: detects card on last assistant turn", () => {
  const history = [
    { role: "user", text: "borrá la última venta" },
    {
      role: "assistant",
      text: "¿Confirmás eliminar la última venta?",
      confirmationRequest: {
        id: "req-1",
        message: "¿Confirmás eliminar la última venta?",
        action: { type: "undo", undoTarget: "sale", undoCount: 1 },
      },
    },
  ];
  const pending = getPendingConfirmation(history);
  assert.ok(pending, "expected pending confirmation");
  assert.equal(pending.id, "req-1");
  assert.equal(pending.action.type, "undo");
});

test("getPendingConfirmation: ignores card if more recent user+assistant pair followed", () => {
  // If the assistant has emitted a fresh reply with no card after the
  // card-bearing turn, the card is no longer in play.
  const history = [
    {
      role: "assistant",
      text: "¿Confirmás eliminar?",
      confirmationRequest: { action: { type: "undo", undoTarget: "sale", undoCount: 1 } },
    },
    { role: "user", text: "hola" },
    { role: "assistant", text: "Hola, ¿en qué te ayudo?" },
  ];
  assert.equal(getPendingConfirmation(history), null);
});

test("getPendingConfirmation: rejects malformed confirmationRequest", () => {
  const history = [
    {
      role: "assistant",
      text: "?",
      confirmationRequest: { id: "bad" }, // no action
    },
  ];
  assert.equal(getPendingConfirmation(history), null);
});
