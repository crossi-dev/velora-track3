const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectActionHallucination,
  HALLUCINATION_FALLBACK_ANSWER,
} = require("../../src/app/api/business-assistant/_lib/answer-hallucination-guard.ts");

// ── Should TRIP (model claimed an action happened) ───────────────────

test("trips on classic 'Listo, registrada la venta'", () => {
  const r = detectActionHallucination("Listo, registrada la venta de 1 tuerca a Carlos.");
  assert.equal(r.matched, true);
});

test("trips on 'la venta quedó registrada'", () => {
  const r = detectActionHallucination("La venta quedó registrada correctamente.");
  assert.equal(r.matched, true);
});

test("trips on 'gasto registrado'", () => {
  const r = detectActionHallucination("Listo, gasto registrado de 500 pesos.");
  assert.equal(r.matched, true);
});

test("trips on 'vendido'", () => {
  const r = detectActionHallucination("Ya está vendido el producto.");
  assert.equal(r.matched, true);
});

test("trips on 'ya quedó'", () => {
  const r = detectActionHallucination("Ya quedó.");
  assert.equal(r.matched, true);
});

test("trips on 'ya está cargado'", () => {
  const r = detectActionHallucination("Ya está cargado el stock.");
  assert.equal(r.matched, true);
});

test("trips on 'Listo, agregué'", () => {
  const r = detectActionHallucination("Listo, agregué a Juan como cliente.");
  assert.equal(r.matched, true);
});

test("trips on 'Listo, eliminé el producto'", () => {
  const r = detectActionHallucination("Listo, eliminé el producto del catálogo.");
  assert.equal(r.matched, true);
});

// ── Should NOT trip (legitimate query answers) ────────────────────────

test("does not trip on legitimate sales-query answer", () => {
  const r = detectActionHallucination("Hoy vendiste 3 productos por un total de 5000 pesos.");
  assert.equal(r.matched, false);
});

test("does not trip on inventory question", () => {
  const r = detectActionHallucination("Te quedan 12 unidades de remera.");
  assert.equal(r.matched, false);
});

test("does not trip on greeting", () => {
  const r = detectActionHallucination("¡Hola! ¿En qué te puedo ayudar?");
  assert.equal(r.matched, false);
});

test("does not trip on past-tense narrative without action noun", () => {
  // "Pagaste 3 cuotas" is a legitimate query response describing history.
  const r = detectActionHallucination("Pagaste 3 cuotas este mes.");
  assert.equal(r.matched, false);
});

test("does not trip on empty answer", () => {
  const r = detectActionHallucination("");
  assert.equal(r.matched, false);
});

// ── Fallback string is non-empty and friendly ────────────────────────

test("fallback answer is non-empty and prompts reformulation", () => {
  assert.ok(HALLUCINATION_FALLBACK_ANSWER.length > 10);
  assert.match(HALLUCINATION_FALLBACK_ANSWER, /\?$/);
});
