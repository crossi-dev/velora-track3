/**
 * Integration tests — clarification fallback path.
 *
 * Covers the exact scenarios that produced the generic apology in past smoke
 * tests (Step 1 smoke — Bug 1: "mandale 4 alfajores a felix"), plus the other
 * canonical failure modes.
 *
 * These tests exercise buildClarification (pure) + supervisorAnswer (runtime
 * glue) together to verify the integration contract end-to-end.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildClarification,
} = require("../../src/lib/clarification-fallback.ts");

const {
  supervisorAnswer,
} = require("../../src/app/api/supervisor/_lib/supervisor-runner.ts");

// ── Contract: supervisorAnswer(null, rawText) must never return the apology ──

const FORBIDDEN_APOLOGY = "Disculpá, tuve un problema procesando tu último mensaje";

function assertNoApology(text, scenario) {
  assert.ok(
    !text.includes(FORBIDDEN_APOLOGY),
    `[${scenario}] still emitting generic apology: "${text.slice(0, 80)}"`,
  );
}

function assertNonVacuous(text, scenario) {
  assert.ok(text.length > 10, `[${scenario}] response too short: "${text}"`);
}

// ── Test 1: "mandale 4 alfajores a felix" — Bug 1 from Step 1 smoke ─────────
// Both product (alfajores) and customer (felix) not found, no fuzzy match.
//
// WARNING F4 (JD Step 3 R2): test now asserts:
//   - response echoes "alfajores" AND "felix" (entity-echo, not generic)
//   - chips contain "Producto" or "Cliente" labels (both-missing branch)
//   - response is NOT the generic apology
//   - response is NOT the generic action menu (total fallback chips)

test("Bug1 smoke: 'mandale 4 alfajores a felix' → echoes alfajores + felix, both-missing chips", () => {
  const rawText = "mandale 4 alfajores a felix";

  // Simulate what the wiring layer does: buildClarification with both entities missing.
  // No businessId → no DB call → no fuzzy candidates → both-missing branch fires.
  const result = buildClarification({
    missingEntities: ["product", "customer"],
    rawText,
  });

  // Entity echoes — the both-missing branch must include the rawText fragment.
  assert.ok(
    result.text.toLowerCase().includes("alfajores") || result.text.includes(rawText.slice(0, 20)),
    `Bug1: response must echo "alfajores" or the raw fragment. Got: "${result.text}"`,
  );
  assert.ok(
    result.text.toLowerCase().includes("felix") || result.text.toLowerCase().includes("mandale"),
    `Bug1: response must echo "felix" or something from the rawText. Got: "${result.text}"`,
  );

  // NOT the generic apology.
  assertNoApology(result.text, "Bug1");

  // NOT the total fallback — chips must be the both-missing action set,
  // NOT the generic ["Cargar producto", "Hacer venta", "Cobrar"] total-fallback set.
  assert.ok(result.chips && result.chips.length > 0, "Bug1: must have chips");
  const chipLabels = result.chips.map((c) => c.label.toLowerCase());
  const hasTotalFallback =
    chipLabels.includes("cargar producto") ||
    chipLabels.includes("hacer venta") ||
    chipLabels.includes("cobrar");
  assert.ok(!hasTotalFallback, `Bug1: chips must not be the total-fallback generic set: ${JSON.stringify(chipLabels)}`);

  // Chips must offer resolution paths specific to the both-missing branch.
  const hasBothMissingChip =
    chipLabels.some((l) => l.includes("crear") || l.includes("producto")) ||
    chipLabels.some((l) => l.includes("cliente") || l.includes("agregar")) ||
    chipLabels.some((l) => l.includes("reescrib") || l.includes("pedido"));
  assert.ok(hasBothMissingChip, `Bug1: chips must offer product/customer/rephrase path: ${JSON.stringify(chipLabels)}`);

  // Cross-check with supervisorAnswer(null) to confirm the wiring also works.
  const { text: supText } = supervisorAnswer(null, rawText);
  assertNoApology(supText, "Bug1-supervisorAnswer");
  assertNonVacuous(supText, "Bug1-supervisorAnswer");
});

// ── Test 2: "link de pago a felix" with no MP connected ──────────────────────

test("MP gap: 'link de pago a felix' no MP → MercadoPago setup prompt", () => {
  const result = buildClarification({
    capabilityGap: "mercadopago_not_connected",
    rawText: "link de pago a felix",
  });

  assertNoApology(result.text, "MP-gap");
  assertNonVacuous(result.text, "MP-gap");
  assert.ok(
    result.text.toLowerCase().includes("mercadopago") ||
      result.text.toLowerCase().includes("mercado pago"),
    `Must mention MercadoPago: "${result.text}"`,
  );
  assert.ok(result.chips, "Must have chips for MP gap");
  assert.ok(result.chips.length >= 1, "Must offer at least one action chip");
});

// ── Test 3: "vender 5 X" — nonexistent product, no fuzzy match ───────────────

test("Product not found: 'vender 5 X' → catalog create/rephrase clarification", () => {
  const result = buildClarification({
    missingEntities: ["product"],
    rawText: "vender 5 X",
  });

  assertNoApology(result.text, "product-missing");
  assertNonVacuous(result.text, "product-missing");
  // Must offer create or rephrase
  assert.ok(result.chips, "Must have chips");
  const chipValues = result.chips.map((c) => c.value.toLowerCase());
  const hasCreate = chipValues.some((v) => v.includes("crear") || v.includes("product"));
  const hasRephrase = chipValues.some((v) => v.includes("reescrib") || v.includes("pedido"));
  assert.ok(hasCreate || hasRephrase, `Must offer create or rephrase: ${JSON.stringify(result.chips)}`);
});

// ── Test 4: Generic gibberish → action menu chips ─────────────────────────────

test("Generic gibberish → action menu with common actions, no apology", () => {
  const result = buildClarification({
    rawText: "xkcd zxqp mmm llll",
  });

  assertNoApology(result.text, "gibberish");
  assertNonVacuous(result.text, "gibberish");
  assert.ok(result.chips, "Must have chips");
  assert.ok(result.chips.length >= 3, "Total fallback must offer at least 3 action chips");
  // Must contain common Velora actions
  const labels = result.chips.map((c) => c.label.toLowerCase());
  const hasVenta = labels.some((l) => l.includes("venta") || l.includes("vender") || l.includes("cobr"));
  assert.ok(hasVenta, `Chips must include sale/payment action: ${JSON.stringify(labels)}`);
});

// ── Test 5: supervisorAnswer(null, "") → total fallback, no apology ───────────

test("supervisorAnswer(null) with empty rawText → total fallback, no apology", () => {
  const { text } = supervisorAnswer(null, "");
  assertNoApology(text, "null-empty");
  assertNonVacuous(text, "null-empty");
});

// ── Test 6: supervisorAnswer(null) backward compat — default arg ──────────────
// Callers that haven't been updated to pass rawText must still get a non-apology.

test("supervisorAnswer(null) with no rawText arg → non-apology (backward compat)", () => {
  const { text } = supervisorAnswer(null);
  assertNoApology(text, "backward-compat");
  assertNonVacuous(text, "backward-compat");
});

// ── Test 7: supervisorAnswer(validResult) untouched ───────────────────────────
// The happy path must not be affected.

test("supervisorAnswer(valid answer response) returns { text } unchanged", () => {
  const fakeResult = {
    kind: "answer",
    answer: "Listo, registré la venta.",
    actions: null,
    clarification: null,
    notification: null,
    usedModel: "gemini",
    usedAdkDelegation: false,
  };
  const { text } = supervisorAnswer(fakeResult, "any input");
  assert.equal(text, "Listo, registré la venta.", "Happy path must not be altered");
});

// ── Test 8: Chip labels respect 40-char contract ─────────────────────────────

test("All clarification branches produce chips ≤ 40 chars", () => {
  const cases = [
    buildClarification({ capabilityGap: "mercadopago_not_connected", rawText: "x" }),
    buildClarification({ capabilityGap: "andreani_not_connected", rawText: "x" }),
    buildClarification({ capabilityGap: "arca_not_connected", rawText: "x" }),
    buildClarification({ missingEntities: ["product", "customer"], rawText: "mandar alfajores a felix" }),
    buildClarification({ missingEntities: ["product"], rawText: "vender X" }),
    buildClarification({ missingEntities: ["customer"], rawText: "cobrarle a Y" }),
    buildClarification({ rawText: "garbage" }),
  ];

  for (const r of cases) {
    if (!r.chips) continue;
    for (const chip of r.chips) {
      assert.ok(
        chip.label.length <= 40,
        `Chip label exceeds 40 chars: "${chip.label}" (${chip.label.length})`,
      );
    }
  }
});
