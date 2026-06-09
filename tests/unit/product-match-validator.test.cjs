const assert = require("node:assert/strict");
const test = require("node:test");

const { validateProductMatch } = require("../../src/app/api/business-assistant/_lib/product-match-validator.ts");

// ── Casos felices ─────────────────────────────────────────────────────

test("ok: todos los tokens del matched aparecen en user text", () => {
  const r = validateProductMatch("cubiertas usadas", "vendí dos cubiertas usadas a juan");
  assert.equal(r.kind, "ok");
});

test("ok: case insensitive + acentos", () => {
  const r = validateProductMatch("Cubiertas Usadas", "Vendí 2 cubiertas usádas");
  assert.equal(r.kind, "ok");
});

test("ok: plural/singular vía prefijo común ≥3", () => {
  const r = validateProductMatch("cubierta nueva", "vendí cubiertas nuevas");
  assert.equal(r.kind, "ok");
});

test("ok: stop-words del matched ignoradas", () => {
  const r = validateProductMatch("aceite de motor", "vendí aceite motor");
  assert.equal(r.kind, "ok");
});

// ── Casos peligrosos: discriminator missing ───────────────────────────

test("discriminator_missing: matched 'usadas' pero user dijo 'nuevas'", () => {
  const r = validateProductMatch("cubiertas usadas", "vendí dos cubiertas nuevas");
  assert.equal(r.kind, "discriminator_missing");
  assert.deepEqual(r.missing, ["usadas"]);
});

test("discriminator_missing: matched con 'nuevo' que no aparece", () => {
  const r = validateProductMatch("auriculares nuevos", "vendí auriculares");
  assert.equal(r.kind, "discriminator_missing");
  assert.deepEqual(r.missing, ["nuevos"]);
});

test("discriminator_missing: marca matched que el user no mencionó", () => {
  const r = validateProductMatch("pintura roja sherwin", "vendí pintura roja");
  assert.equal(r.kind, "discriminator_missing");
  assert.deepEqual(r.missing, ["sherwin"]);
});

test("discriminator_missing: múltiples tokens faltantes", () => {
  const r = validateProductMatch("auriculares bluetooth premium", "vendí auriculares");
  assert.equal(r.kind, "discriminator_missing");
  assert.equal(r.missing.length, 2);
});

// ── Edge cases ────────────────────────────────────────────────────────

test("empty: matched vacío", () => {
  const r = validateProductMatch("", "vendí algo");
  assert.equal(r.kind, "empty");
});

test("empty: user text vacío", () => {
  const r = validateProductMatch("cubiertas", "");
  assert.equal(r.kind, "empty");
});

test("empty: user text solo stop-words", () => {
  const r = validateProductMatch("cubiertas usadas", "de la");
  // "de" "la" tokenizan pero el set Set se llena. Aún así el match falla.
  // Como user tokens != 0 después de tokenize, esto es discriminator_missing
  assert.equal(r.kind, "discriminator_missing");
});

test("empty: matched solo stop-words", () => {
  const r = validateProductMatch("de la", "vendí algo");
  assert.equal(r.kind, "empty");
});
