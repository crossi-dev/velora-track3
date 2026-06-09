const assert = require("node:assert/strict");
const test = require("node:test");

// Stub env vars antes de importar — el módulo bajo test pulls prisma que
// requiere AUTH_SECRET. Solo testeamos funciones puras (isBusinessRuleAction,
// summarizeRuleResults). La execución real contra DB se valida en
// integration / runtime, no acá.
process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-secret-not-for-production";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL || "http://localhost:3000";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-client-id";
process.env.GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "test-client-secret";

const {
  isBusinessRuleAction,
  summarizeRuleResults,
} = require("../../src/app/api/supervisor/_lib/business-rule-actions.ts");

// ── isBusinessRuleAction ───────────────────────────────────────────────

test("isBusinessRuleAction: detecta create_business_rule", () => {
  const result = isBusinessRuleAction({ intent: "create_business_rule", data: {} });
  assert.equal(result, "create");
});

test("isBusinessRuleAction: detecta update_business_rule", () => {
  const result = isBusinessRuleAction({ intent: "update_business_rule", data: {} });
  assert.equal(result, "update");
});

test("isBusinessRuleAction: detecta delete_business_rule", () => {
  const result = isBusinessRuleAction({ intent: "delete_business_rule", data: {} });
  assert.equal(result, "delete");
});

test("isBusinessRuleAction: retorna null para intents fuera de scope", () => {
  assert.equal(isBusinessRuleAction({ intent: "register_sale", data: {} }), null);
  assert.equal(isBusinessRuleAction({ intent: "edit_product", data: {} }), null);
  assert.equal(isBusinessRuleAction({ intent: "answer", data: {} }), null);
  assert.equal(isBusinessRuleAction({ intent: "", data: {} }), null);
});

test("isBusinessRuleAction: case-sensitive (no acepta CREATE_BUSINESS_RULE)", () => {
  assert.equal(isBusinessRuleAction({ intent: "CREATE_BUSINESS_RULE", data: {} }), null);
});

// ── summarizeRuleResults ───────────────────────────────────────────────

test("summarizeRuleResults: ningún rule action → null", () => {
  const result = summarizeRuleResults({ confirmations: [], errors: [], ruleActionCount: 0 });
  assert.equal(result, null);
});

test("summarizeRuleResults: solo confirmations → string concatenado", () => {
  const result = summarizeRuleResults({
    confirmations: ["Listo, regla creada: lavar manos.", "Listo, regla creada: no se fía."],
    errors: [],
    ruleActionCount: 2,
  });
  assert.ok(result);
  assert.ok(result.includes("lavar manos"));
  assert.ok(result.includes("no se fía"));
});

test("summarizeRuleResults: solo errors → prefijo 'Error: '", () => {
  const result = summarizeRuleResults({
    confirmations: [],
    errors: ["regla no encontrada"],
    ruleActionCount: 1,
  });
  assert.ok(result);
  assert.match(result, /^Error: regla no encontrada$/);
});

test("summarizeRuleResults: mezcla confirmations + errors", () => {
  const result = summarizeRuleResults({
    confirmations: ["Listo, regla creada."],
    errors: ["otra falló"],
    ruleActionCount: 2,
  });
  assert.ok(result);
  assert.ok(result.includes("Listo"));
  assert.ok(result.includes("Error: otra falló"));
});

test("summarizeRuleResults: ruleActionCount > 0 pero todo vacío → null", () => {
  // Caso degenerado: hubo rule actions pero ninguna produjo output (no debería pasar
  // en runtime, pero el handler no debe explotar).
  const result = summarizeRuleResults({
    confirmations: [],
    errors: [],
    ruleActionCount: 1,
  });
  assert.equal(result, null);
});

// ── Property: nunca tira con input inesperado ─────────────────────────

test("isBusinessRuleAction: tolerante a action sin data", () => {
  // El check solo mira intent. data missing/invalid no rompe acá.
  assert.equal(isBusinessRuleAction({ intent: "create_business_rule" }), "create");
});

test("summarizeRuleResults: arrays con string vacío", () => {
  // Confirmations con string vacío — junta sin tirar (el caller decide
  // si quiere filtrar antes de llamar summarize).
  const result = summarizeRuleResults({
    confirmations: [""],
    errors: [],
    ruleActionCount: 1,
  });
  // No tira. Output puede ser "" o null dependiendo del filtro interno.
  assert.notEqual(result, undefined);
});
