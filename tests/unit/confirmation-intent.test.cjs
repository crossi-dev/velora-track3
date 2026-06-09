const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isShortConfirmation,
  isShortCancellation,
} = require("../../src/app/dashboard/lib/hooks/confirmation-intent.ts");

// ── isShortConfirmation ──────────────────────────────────────────────

test("confirmation: bare affirmations", () => {
  assert.equal(isShortConfirmation("si"), true);
  assert.equal(isShortConfirmation("sí"), true);
  assert.equal(isShortConfirmation("dale"), true);
  assert.equal(isShortConfirmation("ok"), true);
  assert.equal(isShortConfirmation("okey"), true);
  assert.equal(isShortConfirmation("va"), true);
  assert.equal(isShortConfirmation("confirmo"), true);
  assert.equal(isShortConfirmation("perfecto"), true);
  assert.equal(isShortConfirmation("listo"), true);
  assert.equal(isShortConfirmation("obvio"), true);
});

test("confirmation: punctuation, caps, spaces tolerated", () => {
  assert.equal(isShortConfirmation("Dale!"), true);
  assert.equal(isShortConfirmation("  sí  "), true);
  assert.equal(isShortConfirmation("OK."), true);
  assert.equal(isShortConfirmation("Perfecto!"), true);
});

test("confirmation: rejects compound messages with other intent", () => {
  assert.equal(isShortConfirmation("dale, vendele 3 papas"), false);
  assert.equal(isShortConfirmation("sí pero cambiá el precio"), false);
  assert.equal(isShortConfirmation("ok cargá 5 clavos"), false);
});

test("confirmation: rejects long messages", () => {
  assert.equal(isShortConfirmation("si si si si si si si si si si si"), false);
  assert.equal(isShortConfirmation("dale confirmalo ya mismo por favor"), false);
});

test("confirmation: rejects empty and noise", () => {
  assert.equal(isShortConfirmation(""), false);
  assert.equal(isShortConfirmation("   "), false);
  assert.equal(isShortConfirmation("hola"), false);
  assert.equal(isShortConfirmation("no se"), false);
});

// ── isShortCancellation ──────────────────────────────────────────────

test("cancellation: bare negations", () => {
  assert.equal(isShortCancellation("no"), true);
  assert.equal(isShortCancellation("nope"), true);
  assert.equal(isShortCancellation("cancelar"), true);
  assert.equal(isShortCancellation("cancelá"), true);
  assert.equal(isShortCancellation("olvidalo"), true);
  assert.equal(isShortCancellation("basta"), true);
  assert.equal(isShortCancellation("mejor no"), true);
});

test("cancellation: punctuation and caps tolerated", () => {
  assert.equal(isShortCancellation("No."), true);
  assert.equal(isShortCancellation("NOPE!"), true);
  assert.equal(isShortCancellation("  cancelar  "), true);
});

test("cancellation: rejects compound messages", () => {
  assert.equal(isShortCancellation("no, vendele 2 papas"), false);
  assert.equal(isShortCancellation("cancela pero cargá esto"), false);
});

test("cancellation: rejects confirmations", () => {
  assert.equal(isShortCancellation("si"), false);
  assert.equal(isShortCancellation("dale"), false);
  assert.equal(isShortCancellation("ok"), false);
});

test("cancellation: rejects empty and unrelated", () => {
  assert.equal(isShortCancellation(""), false);
  assert.equal(isShortCancellation("hola"), false);
  assert.equal(isShortCancellation("no me acuerdo"), false);
});

// ── Mutual exclusion ─────────────────────────────────────────────────

test("confirmation and cancellation are mutually exclusive", () => {
  const samples = ["si", "dale", "ok", "perfecto", "no", "cancelar", "nope", "hola", "dale cargá"];
  for (const s of samples) {
    const conf = isShortConfirmation(s);
    const canc = isShortCancellation(s);
    assert.equal(conf && canc, false, `'${s}' matched both`);
  }
});
