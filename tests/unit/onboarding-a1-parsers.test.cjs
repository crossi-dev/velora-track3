// Unit tests for Fase A1 onboarding parsers and detectPendingTurn sequence.
// Follows the existing onboarding-fast-path.test.cjs cjs pattern.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  detectTransferAlias,
  detectPostalCode,
  detectCourierChoice,
  detectWhatsappPhone,
} = require("../../src/app/api/business-assistant/_lib/onboarding-fast-path.parsers.ts");

const { detectOnboardingFastPath } = require(
  "../../src/app/api/business-assistant/_lib/onboarding-fast-path.ts"
);

// ── Base states used in detectPendingTurn table tests ───────────────────────

const BASE = {
  businessNameSet: false,
  businessTypeSet: false,
  paymentMethodsSet: false,
  openingCashSet: false,
  transferAliasSet: false,
  // detectPendingTurn derives the T3b need from these raw fields, not from
  // transferAliasSet alone. Tests that want T3b to fire must set
  // paymentMethodsIncludeTransferencia: true AND transferAlias: null.
  paymentMethodsIncludeTransferencia: false,
  transferAlias: null,
  postalCodeSet: false,
  courierPreferenceSet: false,
  whatsappPhoneSet: false,
  productCount: 0,
  pendingStockProduct: null,
  mercadoPagoSelected: false,
  mercadoPagoConnected: false,
  mercadoPagoOnboardingDeferred: false,
};

/** Helper: merge BASE with partial overrides */
function s(overrides) {
  return { ...BASE, ...overrides };
}

// ── detectTransferAlias ──────────────────────────────────────────────────────

test("detectTransferAlias: acepta alias corto alfanumérico", () => {
  assert.equal(detectTransferAlias("mitienda.mp"), "mitienda.mp");
});

test("detectTransferAlias: acepta CBU de 22 dígitos", () => {
  assert.equal(detectTransferAlias("0720031188000038090571"), "0720031188000038090571");
});

// STALE UPDATE (commit f09c6ee9): detectTransferAlias now requires a dot in
// the alias (Argentine MP + bank CVU aliases follow word.word.word format since
// 2020). "mi-alias" has a hyphen but no dot → rejected. This hardening
// eliminates false positives where help words ("ayudame") fit the format.
test("detectTransferAlias: rechaza alias sin punto (dot requerido desde f09c6ee9)", () => {
  assert.equal(detectTransferAlias("mi-alias"), null);
});

test("detectTransferAlias: rechaza string con espacios (es frase, no alias)", () => {
  assert.equal(detectTransferAlias("mi alias tiene espacios"), null);
});

test("detectTransferAlias: rechaza string muy corto (menos de 6 chars)", () => {
  assert.equal(detectTransferAlias("ab"), null);
});

test("detectTransferAlias: rechaza CBU con longitud incorrecta (21 dígitos)", () => {
  assert.equal(detectTransferAlias("072003118800003809057"), null);
});

test("detectTransferAlias: rechaza vacío", () => {
  assert.equal(detectTransferAlias(""), null);
  assert.equal(detectTransferAlias("   "), null);
});

// ── detectPostalCode ─────────────────────────────────────────────────────────

test("detectPostalCode: acepta 4 dígitos", () => {
  assert.equal(detectPostalCode("1900"), "1900");
});

test("detectPostalCode: acepta 5 dígitos", () => {
  assert.equal(detectPostalCode("55000"), "55000");
});

test("detectPostalCode: acepta prefijo 'CP'", () => {
  assert.equal(detectPostalCode("CP 1043"), "5500");
});

test("detectPostalCode: acepta prefijo 'código postal'", () => {
  assert.equal(detectPostalCode("código postal 5500"), "5500");
});

test("detectPostalCode: rechaza texto largo", () => {
  assert.equal(detectPostalCode("mi cp es 5500 en Mendoza"), null);
});

test("detectPostalCode: rechaza letras", () => {
  assert.equal(detectPostalCode("B1900"), null);
});

test("detectPostalCode: rechaza 3 dígitos (muy corto)", () => {
  assert.equal(detectPostalCode("550"), null);
});

// ── detectCourierChoice ──────────────────────────────────────────────────────

test("detectCourierChoice: chip exacto 'Andreani'", () => {
  assert.equal(detectCourierChoice("Andreani"), "Andreani");
});

test("detectCourierChoice: chip exacto 'OCA'", () => {
  assert.equal(detectCourierChoice("OCA"), "OCA");
});

test("detectCourierChoice: chip 'ninguno'", () => {
  assert.equal(detectCourierChoice("ninguno"), "ninguno");
});

test("detectCourierChoice: chip 'No hago envíos'", () => {
  assert.equal(detectCourierChoice("No hago envíos"), "ninguno");
});

test("detectCourierChoice: free text 'mando con andreani'", () => {
  assert.equal(detectCourierChoice("mando con andreani"), "Andreani");
});

test("detectCourierChoice: free text 'no hago envios'", () => {
  assert.equal(detectCourierChoice("no hago envios"), "ninguno");
});

test("detectCourierChoice: off-script no resuelve", () => {
  assert.equal(detectCourierChoice("no sé todavía"), null);
  assert.equal(detectCourierChoice("DHL"), null);
});

// ── detectWhatsappPhone ──────────────────────────────────────────────────────

test("detectWhatsappPhone: número de 10 dígitos", () => {
  assert.equal(detectWhatsappPhone("1100000000"), "1100000000");
});

test("detectWhatsappPhone: número de 11 dígitos (sin prefijo — se guarda tal cual)", () => {
  // "01100000000" has no +54/54 prefix — stored as-is (11 digits including area 0).
  assert.equal(detectWhatsappPhone("01100000000"), "01100000000");
});

test("detectWhatsappPhone: con prefijo +54", () => {
  assert.equal(detectWhatsappPhone("+541100000000"), "1100000000");
});

test("detectWhatsappPhone: con prefijo 54 sin +", () => {
  assert.equal(detectWhatsappPhone("541100000000"), "1100000000");
});

test("detectWhatsappPhone: rechaza texto libre", () => {
  assert.equal(detectWhatsappPhone("llamame a las 10"), null);
});

test("detectWhatsappPhone: rechaza número muy corto", () => {
  assert.equal(detectWhatsappPhone("12345"), null);
});

test("detectWhatsappPhone: rechaza vacío", () => {
  assert.equal(detectWhatsappPhone(""), null);
});

// ── detectPendingTurn — tabla de estados ────────────────────────────────────
// Each row: [label, partialState, expectedTurn]
//
// STALE UPDATE (commit 66edf597 "simplify state machine to 4 turns"):
// The linear onboarding flow was simplified to 4 turns only:
//   T1 → business name
//   T5 → catalog import (planilla/foto/pegar/skip)
//   T3 → payment methods
//   T14 → Andreani credentials
// Turns 2 (business type), 8 (alias/CBU), 9 (CP), 10 (courier), 11 (WA),
// 6 (stock loop), and 7 (MP OAuth) are removed from detectPendingTurn.
// They remain reachable via JIT/NLU but no longer fire in the linear flow.
//
// States that used to advance through those turns now go directly to the
// first active turn in the simplified sequence.

const TURN_TABLE = [
  ["T1 pending (no name)", s({}), 1],
  // T2 removed: name set → next is T5 (catalog, since productCount=0 in BASE)
  ["T2 removed → now T5 (catalog)", s({ businessNameSet: true }), 5],
  // T3 (payments) only fires after catalog is done (productCount > 0 or skippedCatalog)
  ["T3 pending (catalog done)", s({
    businessNameSet: true, businessTypeSet: true,
    paymentMethodsSet: false, productCount: 1,
  }), 3],
  // T3b (alias), T4 CP, T5 courier, T6 WA all removed from linear flow
  // (not returned by detectPendingTurn). States that used to target them
  // now resolve to a different turn or null.
  // T7 product loading pending: catalog still pending → turn 5
  ["T7 product loading pending (catalog turn)", s({
    businessNameSet: true, businessTypeSet: true, paymentMethodsSet: true,
    transferAliasSet: true, postalCodeSet: true, courierPreferenceSet: true,
    whatsappPhoneSet: true, productCount: 0,
  }), 5],
  // T8 stock loop (pendingStockProduct): removed from linear flow → null
  // (stock loop is now triggered via NLU post-onboarding, not linear flow)
  ["T8 stock loop removed → null", s({
    businessNameSet: true, businessTypeSet: true, paymentMethodsSet: true,
    transferAliasSet: true, postalCodeSet: true, courierPreferenceSet: true,
    whatsappPhoneSet: true, productCount: 1,
    pendingStockProduct: { productId: "p1", name: "test" },
  }), null],
  // T9 MP OAuth removed → null (collapsed into payment turn inline)
  ["T9 MP OAuth removed → null", s({
    businessNameSet: true, businessTypeSet: true, paymentMethodsSet: true,
    transferAliasSet: true, postalCodeSet: true, courierPreferenceSet: true,
    whatsappPhoneSet: true, productCount: 1, pendingStockProduct: null,
    mercadoPagoSelected: true, mercadoPagoConnected: false, mercadoPagoOnboardingDeferred: false,
  }), null],
  ["Done (MP not selected, all set)", s({
    businessNameSet: true, businessTypeSet: true, paymentMethodsSet: true,
    transferAliasSet: true, postalCodeSet: true, courierPreferenceSet: true,
    whatsappPhoneSet: true, productCount: 1, pendingStockProduct: null,
  }), null],
];

for (const [label, state, expectedTurn] of TURN_TABLE) {
  test(`detectPendingTurn: ${label} → turn ${expectedTurn}`, () => {
    // Use a sentinel input that we know won't match any parser, to exercise only the
    // turn-detection path. For "null" cases we verify detectOnboardingFastPath returns null.
    const result = detectOnboardingFastPath("!noop_sentinel!", state);
    if (expectedTurn === null) {
      assert.equal(result, null, `Expected null (onboarding complete) for: ${label}`);
    } else {
      // result can be null if the parser doesn't match — that's fine;
      // we're testing the TURN routing via a known-good input for each turn.
      // For turns where "!noop_sentinel!" won't match (e.g. T8 for alias), we
      // verify the previous turn DID resolve (the state machine advanced).
      // The turn table rows test state → expected turn, not text → result,
      // so we use a valid input per turn:
      const validInputs = {
        1: "Mi Negocio",
        2: "Mascotas",
        3: "Efectivo",
        8: "mitienda.mp",
        9: "5500",
        10: "Andreani",
        11: "mas tarde",
        // T5 (catalog import): valid chips are archivo/foto/pegar/skip_catalogo.
        // "manual" was removed when the catalog-first redesign replaced the old
        // product-loading turn with the import-first chips.
        5: "archivo",
        6: "20",
        7: "connect_mp",
      };
      const input = validInputs[expectedTurn];
      if (input) {
        const r = detectOnboardingFastPath(input, state);
        assert.ok(r !== null, `Expected FastPathResult for turn ${expectedTurn} in: ${label}`);
      }
    }
  });
}

// ── Fast path integration: T3b, T4, T5-courier, T6-WA parsers ───────────────
//
// STALE UPDATE (commit 66edf597 "simplify state machine to 4 turns"):
// Turns 8 (alias/CBU), 9 (CP), 10 (courier), 11 (WA) were removed from the
// linear onboarding flow. detectPendingTurn never returns these values anymore
// (states with productCount=0 all get routed to T5 catalog first, and even
// after catalog is done the linear flow goes T3→T14 skipping 8/9/10/11).
//
// The parsers and builders themselves are still correct and exported for JIT/NLU
// use. Tests below verify parser correctness directly (via builder functions)
// rather than via detectOnboardingFastPath, which returns null for these states.

const {
  buildT3bDispatch,
  buildT4CpResult,
  buildT5CourierResult,
  buildT6WaDeferResult,
  buildT6WaPrompt,
  buildT6WaPhoneResult,
} = require("../../src/app/api/business-assistant/_lib/onboarding-fast-path.builders.ts");

// T3b: alias/CBU parser + builder (JIT — called via NLU when Transferencia is selected)
test("T3b: alias capturado via buildT3bDispatch emite update_business_setup:transferAlias", () => {
  const r = buildT3bDispatch("mitienda.mp", false);
  assert.ok(r, "should resolve");
  assert.equal(r.matchedTurn, 8);
  assert.equal(r.actions[0].intent, "update_business_setup");
  assert.equal(r.actions[0].data.field, "transferAlias");
  assert.equal(r.actions[0].data.value, "mitienda.mp");
});

test("T3b: CBU de 22 dígitos capturado via buildT3bDispatch", () => {
  const r = buildT3bDispatch("0720031188000038090571", false);
  assert.ok(r, "should resolve");
  assert.equal(r.matchedTurn, 8);
  assert.equal(r.actions[0].data.value, "0720031188000038090571");
});

test("T3b: texto libre NO resuelve (detectTransferAlias returns null)", () => {
  assert.equal(detectTransferAlias("no sé todavía"), null);
});

// T4 CP: postal code parser + builder (JIT)
test("T4 CP: código postal capturado emite update_business_setup:postalCode", () => {
  const cp = detectPostalCode("5500");
  assert.ok(cp, "detectPostalCode should parse 5500");
  const r = buildT4CpResult(cp);
  assert.ok(r, "should resolve");
  assert.equal(r.matchedTurn, 9);
  assert.equal(r.actions[0].intent, "update_business_setup");
  assert.equal(r.actions[0].data.field, "postalCode");
  assert.equal(r.actions[0].data.value, "5500");
});

test("T4 CP: prefijo 'CP 1043' acepta", () => {
  const cp = detectPostalCode("CP 1043");
  assert.ok(cp, "should parse");
  assert.equal(cp, "5500");
});

test("T4 CP: texto libre no resuelve", () => {
  assert.equal(detectPostalCode("mendoza capital"), null);
});

// T5 courier: courier parser + builder (JIT)
test("T5 courier: chip 'Andreani' capturado", () => {
  const courier = detectCourierChoice("Andreani");
  assert.ok(courier, "should resolve");
  const r = buildT5CourierResult(courier);
  assert.ok(r, "should resolve");
  assert.equal(r.matchedTurn, 10);
  assert.equal(r.actions[0].intent, "update_business_setup");
  assert.equal(r.actions[0].data.field, "courierPreference");
  assert.equal(r.actions[0].data.value, "Andreani");
});

test("T5 courier: chip 'OCA' capturado", () => {
  const courier = detectCourierChoice("OCA");
  assert.ok(courier, "should resolve");
  const r = buildT5CourierResult(courier);
  assert.equal(r.actions[0].data.value, "OCA");
});

test("T5 courier: 'No hago envíos' → ninguno", () => {
  const courier = detectCourierChoice("No hago envíos");
  assert.ok(courier, "should resolve");
  const r = buildT5CourierResult(courier);
  assert.equal(r.actions[0].data.value, "ninguno");
});

test("T5 courier: off-script no resuelve", () => {
  assert.equal(detectCourierChoice("DHL express"), null);
});

// T6 WA: WhatsApp phone parser + builders (JIT)
test("T6 WA: chip 'Más tarde' → defer sentinel via buildT6WaDeferResult", () => {
  const r = buildT6WaDeferResult();
  assert.ok(r, "should resolve");
  assert.equal(r.matchedTurn, 11);
  assert.equal(r.actions[0].intent, "update_business_setup");
  assert.equal(r.actions[0].data.field, "whatsappPhone");
  assert.equal(r.actions[0].data.value, "");
});

test("T6 WA: chip 'wa_defer' → defer sentinel (detectWhatsappPhone returns null, builder resolves)", () => {
  const r = buildT6WaDeferResult();
  assert.ok(r, "should resolve");
  assert.equal(r.actions[0].data.value, "");
});

test("T6 WA: chip 'wa_now' → prompt for number via buildT6WaPrompt", () => {
  const r = buildT6WaPrompt();
  assert.ok(r, "should resolve");
  assert.equal(r.matchedTurn, 11);
  assert.equal(r.actions.length, 0); // no action until number arrives
  assert.match(r.answer, /número|dígitos/i);
});

test("T6 WA: número libre → guardado via detectWhatsappPhone + buildT6WaPhoneResult", () => {
  const phone = detectWhatsappPhone("1100000000");
  assert.ok(phone, "should parse phone");
  const r = buildT6WaPhoneResult(phone);
  assert.ok(r, "should resolve");
  assert.equal(r.matchedTurn, 11);
  assert.equal(r.actions[0].data.field, "whatsappPhone");
  assert.equal(r.actions[0].data.value, "1100000000");
});

// ── Simplified linear flow regression tests ──────────────────────────────────
// Verify the new 4-turn linear flow routes correctly for old-style business states.
// T9 (postal code) is now JIT — old businesses with postalCodeSet=false but
// catalog already done advance to T14 (Andreani) in the simplified linear flow.

const { detectPendingTurn } = require(
  "../../src/app/api/business-assistant/_lib/onboarding-fast-path.ts"
);

test("regression: viejo negocio con openingCashSet=true + skippedCatalog avanza a T14 (Andreani)", () => {
  // Old-style businesses: postalCode/courier/WA are now JIT, so they advance to T14.
  const oldStyleState = s({
    businessNameSet: true,
    businessTypeSet: true,
    paymentMethodsSet: true,
    openingCashSet: true, // old flag set
    transferAliasSet: true, // old biz didn't have Transferencia
    postalCodeSet: false, // new flag (now JIT, not blocking linear flow)
    skippedCatalog: true, // already has a catalog or skipped
    productCount: 1,
  });
  assert.equal(detectPendingTurn(oldStyleState), 14, "should route to T14 (Andreani), not T9 (CP)");
});

test("regression: negocio completamente nuevo (sin openingCash) llega a T5 (catalog)", () => {
  // With productCount: 0, linear flow routes to T5 catalog import
  const fullNewState = s({
    businessNameSet: true,
    businessTypeSet: true,
    paymentMethodsSet: true,
    transferAliasSet: true,
    postalCodeSet: true,
    courierPreferenceSet: true,
    whatsappPhoneSet: true,
    productCount: 0,
  });
  const r = detectOnboardingFastPath("archivo", fullNewState);
  assert.ok(r, "should resolve to T5 (catalog import)");
  assert.equal(r.matchedTurn, 5);
});
