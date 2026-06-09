// Tests unitarios para onboarding-polish.ts (shim sobre reply-polish.ts)
// _runPolishWithCaller fue eliminado — la lógica de timeout/fallback vive en reply-polish.ts.
// Solo se testean los contratos del shim: flag-off → fallbackText, y las dos guards
// del polishOnboardingAck público (flag ausente, flag=false).

const assert = require("node:assert/strict");
const test = require("node:test");

// polishOnboardingAck es la única API pública que queda en el shim.
// _runPolishWithCaller ya no se exporta — la lógica migró a reply-polish.ts.
const {
  polishOnboardingAck,
} = require(
  "../../src/app/api/business-assistant/_lib/onboarding-polish.ts"
);

// ── Caso 1: flag apagado — zero overhead, retorno inmediato ──────────────

test("devuelve fallbackText cuando ONBOARDING_POLISH_ENABLED no está activo", async () => {
  delete process.env.ONBOARDING_POLISH_ENABLED;
  const result = await polishOnboardingAck({
    turno: 1,
    datoCapturado: "Panadería Don Luis",
    fallbackText: "texto_fallback_original",
  });
  assert.equal(result, "texto_fallback_original");
});

test("devuelve fallbackText cuando ONBOARDING_POLISH_ENABLED=false explícito", async () => {
  process.env.ONBOARDING_POLISH_ENABLED = "false";
  const result = await polishOnboardingAck({
    turno: 2,
    datoCapturado: "Belleza",
    fallbackText: "fallback_false",
  });
  assert.equal(result, "fallback_false");
  delete process.env.ONBOARDING_POLISH_ENABLED;
});

// ── Caso 2: parámetros opcionales no rompen (flag apagado, sin Vertex) ───

test("acepta businessName y businessType sin error cuando flag está apagado", async () => {
  delete process.env.ONBOARDING_POLISH_ENABLED;
  const result = await polishOnboardingAck({
    turno: 3,
    businessName: "Veterinaria San Roque",
    businessType: "Veterinaria",
    datoCapturado: "Efectivo, Mercado Pago",
    fallbackText: "fallback",
  });
  // flag off → fallback directo, no se toca reply-polish
  assert.equal(result, "fallback");
});

test("acepta turno 5 sin businessName sin error cuando flag está apagado", async () => {
  delete process.env.ONBOARDING_POLISH_ENABLED;
  const result = await polishOnboardingAck({
    turno: 5,
    datoCapturado: "foto",
    fallbackText: "fallback_t5",
  });
  assert.equal(result, "fallback_t5");
});
