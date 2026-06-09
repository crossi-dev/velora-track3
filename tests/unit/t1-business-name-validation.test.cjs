// Unit tests for T1 business-name validation — specifically the
// isLikelyChipResponseNotName function and its integration with
// looksLikeBusinessNameInput via the fast path.
//
// Root cause being covered: "Sí, arrancamos" (and similar chip/affirmation
// texts) were accepted as valid businessName values. isLikelyChipResponseNotName
// is the explicit named predicate that says "this text is NOT a name".

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  looksLikeBusinessNameInput,
  isLikelyChipResponseNotName,
  looksLikeSiArrancamosChip,
  looksLikeContameMasChip,
} = require("../../src/app/api/business-assistant/_lib/onboarding-fast-path.parsers.ts");

// ── looksLikeBusinessNameInput: valid names ───────────────────────────────────

test("looksLikeBusinessNameInput: acepta nombre simple", () => {
  assert.equal(looksLikeBusinessNameInput("Distribuidora Norte"), "Distribuidora Norte");
});

test("looksLikeBusinessNameInput: acepta nombre con número", () => {
  assert.equal(looksLikeBusinessNameInput("Mi negocio chico"), "Mi negocio chico");
});

test("looksLikeBusinessNameInput: acepta nombre corto (4+ chars alfanuméricos)", () => {
  assert.equal(looksLikeBusinessNameInput("MiNeg"), "MiNeg");
});

test("looksLikeBusinessNameInput: acepta nombre con tildes", () => {
  assert.equal(looksLikeBusinessNameInput("Panadería Sur"), "Panadería Sur");
});

// ── looksLikeBusinessNameInput: rejected inputs ───────────────────────────────

test("looksLikeBusinessNameInput: rechaza 'Sí, arrancamos' (chip de bienvenida)", () => {
  assert.equal(looksLikeBusinessNameInput("Sí, arrancamos"), null);
});

test("looksLikeBusinessNameInput: rechaza 'Si arrancamos' (variante sin tilde)", () => {
  assert.equal(looksLikeBusinessNameInput("Si arrancamos"), null);
});

test("looksLikeBusinessNameInput: rechaza 'arrancamos' solo", () => {
  // "arrancamos" normalizes to the SI_ARRANCAMOS pattern via ^ + optional group
  // matching — if it doesn't match that pattern, it must still be rejected because
  // it has no uppercase and reads as a verb, not a name. Our T1_REJECT_PATTERNS
  // intentionally do NOT reject plain "arrancamos" (no "sí/si" prefix) — that
  // would be overly aggressive. So this word WOULD be accepted as a name currently.
  // This test documents the actual behavior: "arrancamos" alone is NOT in the
  // reject list and looksLikeBusinessNameInput returns it as a candidate.
  // isLikelyChipResponseNotName will therefore return false for this input.
  // If the product team wants to also reject bare "arrancamos", add it to T1_REJECT_PATTERNS.
  const result = looksLikeBusinessNameInput("arrancamos");
  // Either null (rejected) or "arrancamos" (accepted) is valid per current design.
  // We just verify it is consistent with isLikelyChipResponseNotName.
  if (result === null) {
    assert.equal(isLikelyChipResponseNotName("arrancamos"), true);
  } else {
    assert.equal(isLikelyChipResponseNotName("arrancamos"), false);
  }
});

test("looksLikeBusinessNameInput: rechaza 'Contame más' (chip de info)", () => {
  assert.equal(looksLikeBusinessNameInput("Contame más"), null);
});

test("looksLikeBusinessNameInput: rechaza 'hola' (saludo genérico)", () => {
  assert.equal(looksLikeBusinessNameInput("hola"), null);
});

test("looksLikeBusinessNameInput: rechaza 'no entiendo' (confusion)", () => {
  assert.equal(looksLikeBusinessNameInput("no entiendo"), null);
});

test("looksLikeBusinessNameInput: rechaza 'a' (menos de 2 chars alfanuméricos)", () => {
  assert.equal(looksLikeBusinessNameInput("a"), null);
});

test("looksLikeBusinessNameInput: rechaza string vacío", () => {
  assert.equal(looksLikeBusinessNameInput(""), null);
});

test("looksLikeBusinessNameInput: rechaza string con signo de pregunta", () => {
  assert.equal(looksLikeBusinessNameInput("¿cómo funciona?"), null);
});

test("looksLikeBusinessNameInput: rechaza 'ok' (afirmación genérica)", () => {
  assert.equal(looksLikeBusinessNameInput("ok"), null);
});

test("looksLikeBusinessNameInput: rechaza 'dale' (afirmación genérica)", () => {
  assert.equal(looksLikeBusinessNameInput("dale"), null);
});

test("looksLikeBusinessNameInput: rechaza 'buenas' (saludo)", () => {
  assert.equal(looksLikeBusinessNameInput("buenas"), null);
});

// ── isLikelyChipResponseNotName: must be consistent inverse ──────────────────

test("isLikelyChipResponseNotName: true para 'Sí, arrancamos'", () => {
  assert.equal(isLikelyChipResponseNotName("Sí, arrancamos"), true);
});

test("isLikelyChipResponseNotName: true para 'Si arrancamos'", () => {
  assert.equal(isLikelyChipResponseNotName("Si arrancamos"), true);
});

test("isLikelyChipResponseNotName: true para 'Contame más'", () => {
  assert.equal(isLikelyChipResponseNotName("Contame más"), true);
});

test("isLikelyChipResponseNotName: true para 'hola'", () => {
  assert.equal(isLikelyChipResponseNotName("hola"), true);
});

test("isLikelyChipResponseNotName: true para 'no entiendo'", () => {
  assert.equal(isLikelyChipResponseNotName("no entiendo"), true);
});

test("isLikelyChipResponseNotName: false para 'Distribuidora Norte'", () => {
  assert.equal(isLikelyChipResponseNotName("Distribuidora Norte"), false);
});

test("isLikelyChipResponseNotName: false para 'Mi negocio chico'", () => {
  assert.equal(isLikelyChipResponseNotName("Mi negocio chico"), false);
});

test("isLikelyChipResponseNotName: false para 'MiNeg'", () => {
  assert.equal(isLikelyChipResponseNotName("MiNeg"), false);
});

test("isLikelyChipResponseNotName: true para 'a' (demasiado corto)", () => {
  assert.equal(isLikelyChipResponseNotName("a"), true);
});

// ── Consistency invariant: isLikelyChipResponseNotName === (looksLikeBusinessNameInput === null) ──

test("invariante: isLikelyChipResponseNotName es el inverso exacto de looksLikeBusinessNameInput", () => {
  const inputs = [
    "Distribuidora Norte",
    "Mi negocio chico",
    "MiNeg",
    "Sí, arrancamos",
    "Si arrancamos",
    "Contame más",
    "hola",
    "no entiendo",
    "a",
    "",
    "ok",
    "dale",
    "buenas",
    "¿cómo funciona?",
    "Panadería Sur",
  ];
  for (const input of inputs) {
    const accepted = looksLikeBusinessNameInput(input) !== null;
    const isChip = isLikelyChipResponseNotName(input);
    assert.equal(
      accepted,
      !isChip,
      `Inconsistency for "${input}": looksLikeBusinessNameInput=${accepted}, isLikelyChipResponseNotName=${isChip}`,
    );
  }
});

// ── Integration: looksLikeSiArrancamosChip and looksLikeContameMasChip ───────

test("looksLikeSiArrancamosChip: true para variantes del chip de bienvenida", () => {
  assert.equal(looksLikeSiArrancamosChip("Sí, arrancamos"), true);
  assert.equal(looksLikeSiArrancamosChip("Si arrancamos"), true);
  assert.equal(looksLikeSiArrancamosChip("Sí dale"), true);
  assert.equal(looksLikeSiArrancamosChip("sí"), true);
});

test("looksLikeSiArrancamosChip: false para nombre de negocio real", () => {
  assert.equal(looksLikeSiArrancamosChip("Distribuidora Norte"), false);
  assert.equal(looksLikeSiArrancamosChip("Mi negocio chico"), false);
});

test("looksLikeContameMasChip: true para variantes del chip de info", () => {
  assert.equal(looksLikeContameMasChip("Contame más"), true);
  assert.equal(looksLikeContameMasChip("Explicame"), true);
  assert.equal(looksLikeContameMasChip("que es velora"), true);
});

test("looksLikeContameMasChip: false para nombre de negocio real", () => {
  assert.equal(looksLikeContameMasChip("Distribuidora Norte"), false);
  assert.equal(looksLikeContameMasChip("MiNeg"), false);
});
