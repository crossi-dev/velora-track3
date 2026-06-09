// owner-pipeline-onboarding-release.test.cjs
//
// Behavioral tests for mightBeActionIntent() and shouldReleaseOnboardingTurn()
// after OA Phase 4 cleanup (2026-05-30): Flash classifier removed, the
// onboarding release gate now uses a regex over raw user text.
//
// Design intent (wide regex):
//   - False positive (release on a query) → harmless (OA/Supervisor resolves it)
//   - False negative (keep an action in onboarding) → bad (onboarding steals turn)
//   So the regex errs on the side of releasing.
//
// mightBeActionIntent("cargar producto X") → true   (action verb present)
// mightBeActionIntent("cómo va el negocio") → false  (no action verb)
//
// shouldReleaseOnboardingTurn(text, pendingTurn):
//   no action verb                 → false (keep in onboarding)
//   action verb, T5, product verb  → false (T5 owns catalog-creation verbs)
//   action verb, T5, sale/undo     → true  (sale/undo still release at T5)
//   action verb, T ≠ 5             → true  (release to OA / Supervisor)
//
// Source (verified HTTP 200 2026-05-28): https://adk.dev/workflows/collaboration/

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  mightBeActionIntent,
  shouldReleaseOnboardingTurn,
} = require("../../src/app/api/business-assistant/_lib/owner-handler.stages-onboarding-agent.release.ts");

// ── mightBeActionIntent ───────────────────────────────────────────────────────

test("mightBeActionIntent: action verb phrases → true", () => {
  const actionPhrases = [
    "cargar producto alfajor",
    "cargá un producto",
    "creá el artículo fideos",
    "crear producto",
    "agregar stock",
    "registrar una venta",
    "vendé 2 alfajores",
    "vendi una tuerca a felix",
    "ajustar stock de vasos",
    "modificá el precio",
    "editá el producto",
    "actualizar precios",
    "subí el precio",
    "borrá la venta",
    "eliminar el producto",
    "descontá 5 unidades",
    "nuevo proveedor mendoza",
    "nueva cliente maria",
    "registrá un movimiento",
    "movimiento de caja",
    "cliente nuevo",
    "proveedor distribuidora",
  ];
  for (const phrase of actionPhrases) {
    assert.equal(
      mightBeActionIntent(phrase),
      true,
      `Expected mightBeActionIntent("${phrase}") === true`,
    );
  }
});

test("mightBeActionIntent: clear query/greeting phrases without action verbs → false", () => {
  // These phrases have no action verb from the regex set.
  // "cuánto vendí hoy" is intentionally excluded: "vendí" IS in the regex (wide by design).
  const queryPhrases = [
    "cómo va el negocio",
    "resumen del día",
    "hola",
    "gracias",
    "qué puedo hacer",
    "ayuda",
    "dame el stock",
    "cuánto hay de alfajores",
    "decime el precio de las tuercas",
    "cuál es la venta de hoy",
    "historial de juan",
  ];
  for (const phrase of queryPhrases) {
    assert.equal(
      mightBeActionIntent(phrase),
      false,
      `Expected mightBeActionIntent("${phrase}") === false`,
    );
  }
});

test("mightBeActionIntent: empty / blank input → false", () => {
  assert.equal(mightBeActionIntent(""), false);
  assert.equal(mightBeActionIntent("   "), false);
  // @ts-ignore — runtime guard test
  assert.equal(mightBeActionIntent(null), false);
  // @ts-ignore
  assert.equal(mightBeActionIntent(undefined), false);
});

// ── shouldReleaseOnboardingTurn ───────────────────────────────────────────────

test("release guard: query text without action verbs → keep in onboarding", () => {
  assert.equal(shouldReleaseOnboardingTurn("cómo va el negocio", 1), false);
  assert.equal(shouldReleaseOnboardingTurn("dame el stock", 5), false);
  assert.equal(shouldReleaseOnboardingTurn("hola", 1), false);
});

test("release guard: product-creation verb at T5 → keep (T5 owns catalog-creation)", () => {
  // JD Fase 6 H1 fix: user mid-T5 types "cargar producto alfajor" →
  // must stay in onboarding T5 so the state machine can advance.
  assert.equal(
    shouldReleaseOnboardingTurn("cargar producto alfajor", 5),
    false,
    "carg* at T5 must stay in onboarding",
  );
  assert.equal(
    shouldReleaseOnboardingTurn("cargá alfajor 800", 5),
    false,
    "cargá at T5 must stay in onboarding",
  );
  assert.equal(
    shouldReleaseOnboardingTurn("creá un producto", 5),
    false,
    "cre* at T5 must stay in onboarding",
  );
});

test("release guard: action text at non-T5 → release", () => {
  // Design §7.2: T1 action verbs do NOT release (name gate).
  // T3+ with action verbs: release so OA/Pro can act on the intent.
  assert.equal(shouldReleaseOnboardingTurn("creá cliente felix", 3), true);
  assert.equal(shouldReleaseOnboardingTurn("vendé 2 tuercas", 6), true);
  assert.equal(shouldReleaseOnboardingTurn("registrá un movimiento de 1000", 12), true);
  assert.equal(shouldReleaseOnboardingTurn("nuevo proveedor mendoza", 2), true);
});

test("release guard: T1 name-gate — action verbs at T1 must NOT release (design §7.2)", () => {
  // When business name is not yet set (pendingTurn === 1), ALL turns must stay
  // in onboarding regardless of action verbs. The name is the prerequisite.
  assert.equal(
    shouldReleaseOnboardingTurn("cargar producto alfajor", 1),
    false,
    "carg* at T1 must stay in onboarding (name gate)",
  );
  assert.equal(
    shouldReleaseOnboardingTurn("vendé 2 alfajores", 1),
    false,
    "sale intent at T1 must stay in onboarding (name gate)",
  );
  assert.equal(
    shouldReleaseOnboardingTurn("registrá una venta", 1),
    false,
    "registrá at T1 must stay in onboarding (name gate)",
  );
  assert.equal(
    shouldReleaseOnboardingTurn("nuevo cliente carlos", 1),
    false,
    "nuevo at T1 must stay in onboarding (name gate)",
  );
});

test("release guard: sale/undo verb at T5 → release (only product-creation verbs locked at T5)", () => {
  // T5 gate only locks product-creation verbs for the catalog flow.
  // Sale and undo verbs cannot advance the T5 state machine, so they still release.
  assert.equal(
    shouldReleaseOnboardingTurn("vendé 2 alfajores a felix", 5),
    true,
    "sale intent at T5 should still release",
  );
  assert.equal(
    shouldReleaseOnboardingTurn("borrá la última venta", 5),
    true,
    "undo intent at T5 should still release",
  );
});

test("release guard: empty / blank text → keep in onboarding", () => {
  assert.equal(shouldReleaseOnboardingTurn("", 1), false);
  assert.equal(shouldReleaseOnboardingTurn("   ", 5), false);
});
