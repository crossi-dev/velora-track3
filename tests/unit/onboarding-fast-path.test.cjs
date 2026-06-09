const assert = require("node:assert/strict");
const test = require("node:test");

const { detectOnboardingFastPath } = require(
  "../../src/app/api/business-assistant/_lib/onboarding-fast-path.ts"
);

// Estados típicos de cada turno del onboarding.
// New flags (transferAliasSet, postalCodeSet, courierPreferenceSet, whatsappPhoneSet)
// default to true from T4 onwards so that old tests that tested T4/T5+ still work
// against the same turns (the new intermediate turns are considered already done).
// T12/T13/T14 flags also default to "done" so existing tests are unaffected.
const NEW_FLAGS_DONE = {
  transferAliasSet: true,
  postalCodeSet: true,
  courierPreferenceSet: true,
  whatsappPhoneSet: true,
};
// T12-T14 flags: set to "done" for states that predate these turns, so existing
// tests continue to test their intended turns without triggering T12/T13/T14.
const NEW_FLAGS_T12T14_DONE = {
  customerCount: 1,
  customersOnboardingSkipped: false,
  arcaCertConnected: true,
  arcaOnboardingDeferred: false,
  courierCredentialsConnected: true,
  andreaniOnboardingDeferred: false,
  courierPreference: "Andreani",
};
const T1_STATE = {
  businessNameSet: false,
  businessTypeSet: false,
  paymentMethodsSet: false,
  openingCashSet: false,
  transferAliasSet: false,
  postalCodeSet: false,
  courierPreferenceSet: false,
  whatsappPhoneSet: false,
  productCount: 0,
  ...NEW_FLAGS_T12T14_DONE,
};
const T2_STATE = { ...T1_STATE, businessNameSet: true };
const T3_STATE = { ...T2_STATE, businessTypeSet: true };
// T4_STATE simulates "payment methods done, new intermediate turns done" (old T4 context).
const T4_STATE = { ...T3_STATE, paymentMethodsSet: true, ...NEW_FLAGS_DONE };
// T5_STATE was "opening cash done, ready for products" — in new sequence this means
// all new data turns are done and productCount=0 (ready for product loading turn).
const T5_STATE = { ...T4_STATE, openingCashSet: true };
const DONE_STATE = { ...T5_STATE, productCount: 1 };

// States for the post-product turns (T12 clientes, T13 ARCA, T14 Andreani).
// Each one keeps everything before it "done" so only the turn under test fires.
const T12_STATE = {
  ...T5_STATE, productCount: 1,
  customerCount: 0, customersOnboardingSkipped: false,
};
const T13_STATE = {
  ...T12_STATE, customerCount: 1,
  arcaCertConnected: false, arcaOnboardingDeferred: false,
};
const T14_STATE = {
  ...T13_STATE, arcaCertConnected: true,
  courierCredentialsConnected: false, andreaniOnboardingDeferred: false,
  courierPreference: "Andreani",
};

// ── Onboarding completo: no debería dispararse en ningún caso ──────────────
test("returns null cuando el onboarding está completo", () => {
  for (const text of ["foto", "Veterinaria San Roque", "veinte mil"]) {
    assert.equal(detectOnboardingFastPath(text, DONE_STATE), null);
  }
});

// ── T1 nombre del negocio ──────────────────────────────────────────────────
test("T1: acepta nombre simple", () => {
  const r = detectOnboardingFastPath("Veterinaria San Roque", T1_STATE);
  assert.equal(r?.matchedTurn, 1);
  assert.equal(r.actions[0].intent, "update_business_setup");
  assert.equal(r.actions[0].data.field, "businessName");
  assert.equal(r.actions[0].data.value, "Veterinaria San Roque");
  // 1-step onboarding (2026-05-29): no T3 chips — gate releases after name.
  assert.equal(r.chips, null);
  assert.match(r.answer, /tarjeta de configuraci[oó]n/);
});

// T1 non-name inputs now return a deterministic prompt asking for the business
// name (instead of returning null and falling to the LLM, which was observed
// to hallucinate "anotado, ¿cómo cobrás?" and skip the name turn entirely).
function assertT1NamePrompt(r) {
  assert.ok(r, "T1 should always return a result (name or prompt), never null");
  assert.equal(r.matchedTurn, 1);
  // 1-step redesign (2026-05-29): prompt copy updated.
  assert.equal(r.answer, "¿Cómo se llama tu negocio?");
  assert.deepEqual(r.actions, []);
  assert.equal(r.chips, null);
}

// T1 free-text confusion (empty, questions, help words, long paragraphs) is
// routed to the supervisor LLM — the welcome is a conversational moment, not
// a data capture. Only the welcome chips ("Sí, arrancamos" / "Contame más")
// and real business names produce deterministic results from the fast path.
test("T1: vacío y whitespace → null (LLM handles)", () => {
  assert.equal(detectOnboardingFastPath("", T1_STATE), null);
  assert.equal(detectOnboardingFastPath("   ", T1_STATE), null);
});

test("T1: preguntas y comandos → null (LLM handles)", () => {
  assert.equal(detectOnboardingFastPath("¿qué hago?", T1_STATE), null);
  assert.equal(detectOnboardingFastPath("ayuda", T1_STATE), null);
  assert.equal(detectOnboardingFastPath("no sé", T1_STATE), null);
  assert.equal(detectOnboardingFastPath("no entiendo", T1_STATE), null);
});

test("T1: string demasiado largo (parece párrafo) → null (LLM handles)", () => {
  const long = "esto es una descripción muy larga de mi negocio que claramente no es un nombre sino un párrafo entero de explicación detallada y exhaustiva sobre lo que vendo y a quién";
  assert.equal(detectOnboardingFastPath(long, T1_STATE), null);
});

test("T1: chip welcome 'Sí, arrancamos' → prompt nombre (no se toma como name)", () => {
  assertT1NamePrompt(detectOnboardingFastPath("Sí, arrancamos", T1_STATE));
  assertT1NamePrompt(detectOnboardingFastPath("Si arrancamos", T1_STATE));
  assertT1NamePrompt(detectOnboardingFastPath("Sí dale", T1_STATE));
});

test("T1: chip welcome 'Contame más' → explainer + pregunta del nombre", () => {
  const r = detectOnboardingFastPath("Contame más", T1_STATE);
  assert.ok(r, "Contame más should return an explainer result");
  assert.equal(r.matchedTurn, 1);
  assert.deepEqual(r.actions, []);
  assert.equal(r.chips, null);
  // The explainer must include the pain frame, the concrete example, and the
  // closing name question — verified by substring so we can iterate copy
  // without re-writing the test.
  assert.match(r.answer, /coordin[áa]s todo a mano/);
  assert.match(r.answer, /caja de alfajores/);
  assert.match(r.answer, /c[óo]mo se llama tu negocio/);
});

test("T1: 'Contame más' variants también pegan al explainer", () => {
  for (const variant of ["Cuentame mas", "Explicame", "que es velora", "info"]) {
    const r = detectOnboardingFastPath(variant, T1_STATE);
    assert.ok(r);
    assert.match(r.answer, /caja de alfajores/, `variant '${variant}' should trigger explainer`);
  }
});

// ── E2E: welcome chip → name prompt → real name → checklist intro ────────────
// 1-step redesign (2026-05-29): T3 chips removed; gate releases after name.
test("E2E T1: 'Sí, arrancamos' → prompt → 'Veterinaria San Roque' → checklist intro", () => {
  const stepOne = detectOnboardingFastPath("Sí, arrancamos", T1_STATE);
  assert.ok(stepOne);
  assert.equal(stepOne.matchedTurn, 1);
  assert.equal(stepOne.answer, "¿Cómo se llama tu negocio?");
  assert.deepEqual(stepOne.actions, []);
  assert.equal(stepOne.chips, null);

  const stepTwo = detectOnboardingFastPath("Veterinaria San Roque", T1_STATE);
  assert.ok(stepTwo);
  assert.equal(stepTwo.matchedTurn, 1);
  assert.equal(stepTwo.actions[0].data.field, "businessName");
  assert.equal(stepTwo.actions[0].data.value, "Veterinaria San Roque");
  assert.match(stepTwo.answer, /Veterinaria San Roque, anotado/);
  assert.match(stepTwo.answer, /tarjeta de configuraci[oó]n/);
  assert.equal(stepTwo.chips, null);
});

test("E2E T1: 'Contame más' → explainer → real name → checklist intro", () => {
  const stepOne = detectOnboardingFastPath("Contame más", T1_STATE);
  assert.ok(stepOne);
  assert.deepEqual(stepOne.actions, []);
  assert.match(stepOne.answer, /caja de alfajores/);

  const stepTwo = detectOnboardingFastPath("Distribuidora Norte SA", T1_STATE);
  assert.ok(stepTwo);
  assert.equal(stepTwo.actions[0].data.field, "businessName");
  assert.equal(stepTwo.chips, null);
  assert.match(stepTwo.answer, /tarjeta de configuraci[oó]n/);
});

test("E2E T1: simulated state advance — after businessName saved, gate releases", () => {
  const stateAfterName = { ...T1_STATE, businessNameSet: true };
  const r = detectOnboardingFastPath("Efectivo", stateAfterName);
  // 1-step redesign: gate open after name → null (setup continues in dashboard).
  assert.equal(r, null, "gate released — fast path returns null");
});

test("T1: saludos genéricos → null (LLM handles)", () => {
  assert.equal(detectOnboardingFastPath("hola", T1_STATE), null);
  assert.equal(detectOnboardingFastPath("Hola!", T1_STATE), null);
  assert.equal(detectOnboardingFastPath("buenas", T1_STATE), null);
});

// ── T2 (business type) — REMOVED from the onboarding flow (commit 14c625b2).
// The detectPendingTurn state machine no longer returns 2; the legacy chip
// + detectBusinessType + buildT2Result remain exported for backward compat
// but are unreachable from the onboarding pipeline.

// ── T3 métodos de pago — GATE RELEASED (2026-05-29) ──────────────────────────
// T3_STATE.businessNameSet=true → detectPendingTurn returns null → all null.
test("T3: 'Efectivo' solo — gate released, returns null", () => {
  assert.equal(detectOnboardingFastPath("Efectivo", T3_STATE), null);
});

test("T3: input off-script ('no sé todavía') → null (supervisor LLM handles)", () => {
  assert.equal(detectOnboardingFastPath("no sé todavía", T3_STATE), null);
});

// ── T4 código postal (nuevo — reemplaza "caja inicial") ───────────────────
// T4_CP_STATE: T3 done (paymentMethods set, no Transferencia), new flags pending except CP.
const T4_CP_STATE = {
  ...T3_STATE,
  paymentMethodsSet: true,
  transferAliasSet: true,   // no Transferencia in methods
  postalCodeSet: false,     // CP is the pending turn
  courierPreferenceSet: false,
  whatsappPhoneSet: false,
  productCount: 0,
};

// T4 CP: gate released → null (2026-05-29 1-step redesign)
test("T4 CP: gate released → null", () => {
  assert.equal(detectOnboardingFastPath("5500", T4_CP_STATE), null);
  assert.equal(detectOnboardingFastPath("CP 1900", T4_CP_STATE), null);
});

test("T4 CP: input off-script → null (supervisor LLM handles)", () => {
  assert.equal(detectOnboardingFastPath("no sé cuánto", T4_CP_STATE), null);
  assert.equal(detectOnboardingFastPath("después te digo", T4_CP_STATE), null);
});

// ── T5 catalog turn — ACTIVE in v3 (2026-06-04) ──────────────────────────────
// Onboarding v3: after the name, detectPendingTurn returns 5 (catalog offer).
// Catalog chips resolve via case 5; off-script falls to the LLM agent.
test("T5 catalog: chips return a turn-5 result", () => {
  assert.equal(detectOnboardingFastPath("foto", T5_STATE)?.matchedTurn, 5);
  assert.equal(detectOnboardingFastPath("archivo", T5_STATE)?.matchedTurn, 5);
  assert.equal(detectOnboardingFastPath("skip_catalogo", T5_STATE)?.matchedTurn, 5);
});

// T5 off-script → null (the LLM agent handles confusion at the catalog turn)
test("T5: off-script ('no sé' / 'ayuda con esto') → null (LLM agent handles)", () => {
  assert.equal(detectOnboardingFastPath("no sé", T5_STATE), null);
  assert.equal(detectOnboardingFastPath("ayuda con esto", T5_STATE), null);
});

// ── T12/T13/T14 — GATE RELEASED (2026-05-29) ─────────────────────────────────
test("T12: gate released → null", () => {
  assert.equal(detectOnboardingFastPath("customers_manual", T12_STATE), null);
  assert.equal(detectOnboardingFastPath("customers_saltar", T12_STATE), null);
});

test("T13: question '¿qué es ARCA?' devuelve null (LLM handles)", () => {
  assert.equal(detectOnboardingFastPath("¿qué es ARCA?", T13_STATE), null);
});

test("T13: gate released → null", () => {
  assert.equal(detectOnboardingFastPath("arca_connect", T13_STATE), null);
  assert.equal(detectOnboardingFastPath("arca_defer", T13_STATE), null);
});

// ── T14 — GATE RELEASED (2026-05-29) ─────────────────────────────────────────
test("T14: chip 'andreani_connect' — gate released → null", () => {
  const r = detectOnboardingFastPath("andreani_connect", T14_STATE);
  assert.equal(r, null);
});

test("T14: unrecognized text → null (supervisor handles)", () => {
  // The deterministic prompt for T14 (with the dynamic courier label) is
  // still produced by buildTAndreaniPrompt — it is now reserved for the
  // supervisor-failure catch-all, not for off-script text inside the fast
  // path. Unrecognized text returns null so the supervisor responds.
  const ocaState = { ...T14_STATE, courierPreference: "OCA" };
  assert.equal(detectOnboardingFastPath("xyz", ocaState), null);
});

test("T14: gate released → null", () => {
  assert.equal(detectOnboardingFastPath("andreani_defer", T14_STATE), null);
  assert.equal(detectOnboardingFastPath("andreani_connect", T14_STATE), null);
});

// T5: gate released → all null (2026-05-29)
test("T5: chip 'Subir Excel o CSV' / variantes → gate released → null", () => {
  for (const v of ["subir excel o csv", "excel", "planilla", "cargar manual", "voz", "saco foto", "cuaderno"]) {
    assert.equal(detectOnboardingFastPath(v, T5_STATE), null, `gate released — '${v}' must return null`);
  }
});

test("T5: off-script → null (supervisor LLM handles)", () => {
  assert.equal(detectOnboardingFastPath("no sé", T5_STATE), null);
  assert.equal(detectOnboardingFastPath("ayuda con esto", T5_STATE), null);
});

// ── Ordenamiento secuencial ───────────────────────────────────────────────
test("turnos avanzan en orden — si T1 no está, T2/3/4/5 no se evalúan", () => {
  // Estado T1 pendiente con todos los demás flags falsos. Si pasamos "foto"
  // (respuesta válida para T5), igual debe procesarse como T1 (nombre).
  const r = detectOnboardingFastPath("MiNegocio", T1_STATE);
  assert.equal(r?.matchedTurn, 1);
  assert.equal(r.actions[0].data.field, "businessName");
});

// Smoke: v3 — name turn (T1) captures the name; catalog turn (T5) is active.
test("smoke: v3 design — T1 captures name, T5 is the catalog turn", () => {
  // T1: real business name → captured.
  const r = detectOnboardingFastPath("Veterinaria Sur", T1_STATE);
  assert.ok(r, "T1 must resolve Fast Path");
  assert.equal(r.matchedTurn, 1);
  assert.equal(r.actions[0].data.field, "businessName");

  // T5_STATE: catalog chips resolve to a turn-5 result; off-script → null (LLM).
  assert.equal(detectOnboardingFastPath("foto", T5_STATE)?.matchedTurn, 5);
  assert.equal(detectOnboardingFastPath("escribir a mano", T5_STATE), null);
});

// ── T5b: stock inicial del primer producto ────────────────────────────────
const T5B_STATE = {
  ...T5_STATE,
  productCount: 1,
  pendingStockProduct: { productId: "prod-alfajor-tito", name: "alfajor Tito" },
};

// 1-step redesign: T5B_STATE.businessNameSet=true → gate open → null.
test("T5b: gate released → null", () => {
  assert.equal(detectOnboardingFastPath("20", T5B_STATE), null);
  assert.equal(detectOnboardingFastPath("no sé", T5B_STATE), null);
  assert.equal(detectOnboardingFastPath("ninguno", T5B_STATE), null);
  assert.equal(detectOnboardingFastPath("veinte", T5B_STATE), null);
});

test("T5b: rechaza monto con formato monetario", () => {
  // "$500" parece precio, no cantidad — dejar que el LLM aclare.
  assert.equal(detectOnboardingFastPath("$500", T5B_STATE), null);
  assert.equal(detectOnboardingFastPath("20.000", T5B_STATE), null);
});

test("T5b: rechaza texto libre que no es número ni 'no sé'", () => {
  assert.equal(detectOnboardingFastPath("alfajor 500", T5B_STATE), null);
  assert.equal(detectOnboardingFastPath("borrá esto", T5B_STATE), null);
});

test("T5b: sin pendingStockProduct no se dispara", () => {
  const stateNoPending = { ...T5_STATE, productCount: 1, pendingStockProduct: null };
  assert.equal(detectOnboardingFastPath("20", stateNoPending), null);
});

// ── Bug fix: T2 change after resolved ─────────────────────────────────────
// v3 (2026-06-04): the T2-update guard explicitly excludes the catalog turn
// (turn 5), so business-type words at the catalog turn are NOT hijacked as type
// changes — they fall to the LLM agent (or parse as products). T2 update is JIT
// via the Supervisor LLM when the owner explicitly asks to change their type.

test("T2 update: catalog turn does not hijack type words → null (LLM handles)", () => {
  // T3_STATE/T4_STATE resolve to the catalog turn (5), excluded from the T2 guard → null.
  assert.equal(detectOnboardingFastPath("Mini-market", T3_STATE), null);
  assert.equal(detectOnboardingFastPath("minimarket", T3_STATE), null);
  assert.equal(detectOnboardingFastPath("quise decir Mini-market", T3_STATE), null);
  assert.equal(detectOnboardingFastPath("cambiá el tipo a kiosco", T4_STATE), null);
  assert.equal(detectOnboardingFastPath("no, es Belleza", T3_STATE), null);
});

test("T2 update: texto libre sin tipo conocido → null (Supervisor LLM handles)", () => {
  assert.equal(detectOnboardingFastPath("vendo otra cosa", T3_STATE), null);
});

// ── T5 catalog turn — product input is CAPTURED in v3 (2026-06-04) ───────────
// At the catalog turn, a pasted product list IS the catalog load. The fast-path
// (dead in the pipeline; the LLM agent owns this live) parses it as a bulk import.
test("T5 catalog: pasted product list is captured (turn 5)", () => {
  const r = detectOnboardingFastPath("alfajor 500\nbizcochuelo 1200", T5_STATE);
  assert.equal(r?.matchedTurn, 5);
});

// Off-script (no parseable price, or a question) → null → the LLM agent handles it.
test("T5 catalog: off-script → null (LLM agent handles)", () => {
  assert.equal(detectOnboardingFastPath("800", T5_STATE), null);
  assert.equal(detectOnboardingFastPath("no sé qué cargar", T5_STATE), null);
});

// ── T5b/T5c/T5d — GATE RELEASED (2026-05-29) ─────────────────────────────────
// T5B_STATE extends T5_STATE (businessNameSet=true) → gate open → null.
// Stock loop (T6) is no longer in the linear flow either.
test("T5b/T5c/T5d: gate released → null", () => {
  assert.equal(detectOnboardingFastPath("20", T5B_STATE), null);
  assert.equal(detectOnboardingFastPath("10", T5B_STATE), null);
  assert.equal(detectOnboardingFastPath("0", T5B_STATE), null);
  assert.equal(detectOnboardingFastPath("otro", T5B_STATE), null);
  assert.equal(detectOnboardingFastPath("listo", T5B_STATE), null);
});

// ── T5d no rompe T5c: regression check (now both null) ───────────────────────
test("T5c: número puro — gate released → null", () => {
  const r = detectOnboardingFastPath("20", T5B_STATE);
  assert.equal(r, null);
});

// ─────────────────────────────────────────────────────────────────────────
// ADVERSARIAL MATRIX — confused-owner inputs across every onboarding turn
// ─────────────────────────────────────────────────────────────────────────
// Each turn must NEVER persist garbage data when the owner types help words,
// confusion words, or lone punctuation. The contract is:
//   - actions === [] (nothing persisted), AND
//   - matchedTurn matches the pending turn (deterministic re-prompt), AND
//   - answer is non-empty (the owner gets useful next-step guidance).
//
// Turn 6 (stock loop) is exempt — "no se" maps to quantity=0 there by design.

const CONFUSED_INPUTS = [
  "ayuda", "ayudame", "ayudenme", "socorro", "help",
  "no se", "no entiendo", "no entendi", "me perdi", "estoy perdido",
  "perdon", "disculpa", "mmm", "uhh",
  "?", "¿?", "...", "??",
  "cancelar", "volver", "atras", "parar",
];

// T1 is intentionally excluded — confused inputs at T1 fall to the supervisor
// LLM by design (see T1 tests above). The adversarial assertion below only
// covers turns where deterministic re-prompts are the contract.
const TURN_STATES = [
  { label: "T3 (payment methods)", state: T3_STATE, matchedTurn: 3 },
  { label: "T4 (postal code)", state: T4_CP_STATE, matchedTurn: 9 },
  { label: "T5 (product mode)", state: T5_STATE, matchedTurn: 5 },
  { label: "T12 (customers)", state: T12_STATE, matchedTurn: 12 },
  { label: "T13 (ARCA)", state: T13_STATE, matchedTurn: 13 },
  { label: "T14 (Andreani)", state: T14_STATE, matchedTurn: 14 },
];

for (const { label, state } of TURN_STATES) {
  test(`adversarial: ${label} returns null on confused input (supervisor handles)`, () => {
    for (const input of CONFUSED_INPUTS) {
      const r = detectOnboardingFastPath(input, state);
      assert.equal(r, null, `${label} '${input}': expected null, got ${JSON.stringify(r)}`);
    }
  });
}

// T3b (alias) adversarial — uses a state where Transferencia was selected.
const T3B_STATE = {
  ...T3_STATE,
  paymentMethodsSet: true,
  paymentMethodsIncludeTransferencia: true,
  transferAlias: null,
  transferAliasSet: false,
};

test("adversarial: T3b (alias) returns null on confused input (supervisor handles)", () => {
  for (const input of CONFUSED_INPUTS) {
    const r = detectOnboardingFastPath(input, T3B_STATE);
    assert.equal(r, null, `T3b '${input}': expected null, got ${JSON.stringify(r)}`);
  }
});

test("adversarial: T3b rejects single-word inputs without dots → null", () => {
  // The original bug — "ayudame" passed the format check (3-20 chars,
  // letters only) and was saved as alias. The new dot requirement in
  // detectTransferAlias makes the fast path return null for any single-word
  // input; the supervisor LLM then asks the owner to retype with the right
  // shape (or recovers from confusion if that's what it really was).
  for (const input of ["ayudame", "carlitos", "facu", "tienda", "mp"]) {
    const r = detectOnboardingFastPath(input, T3B_STATE);
    assert.equal(r, null, `T3b '${input}': expected null, got ${JSON.stringify(r)}`);
  }
});

test("adversarial: T3b — gate released (T3B_STATE.businessNameSet=true) → null", () => {
  // 1-step redesign (2026-05-29): T3B_STATE extends T3_STATE (businessNameSet=true),
  // so detectPendingTurn returns null. T3b (alias) is now JIT via Supervisor LLM.
  // The parser (detectTransferAlias) still correctly accepts dotted aliases and CBUs —
  // tested independently by the unit tests in onboarding-a1-parsers.test.cjs.
  assert.equal(detectOnboardingFastPath("carlos.rossi.mp", T3B_STATE), null);
  assert.equal(detectOnboardingFastPath("0123456789012345678901", T3B_STATE), null);
});
