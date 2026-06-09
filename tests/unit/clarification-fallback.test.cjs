/**
 * Unit tests for src/lib/clarification-fallback.ts
 *
 * Covers:
 * - All 6 clarification branches (capability gap, both missing, product
 *   missing with/without fuzzy, customer missing with/without fuzzy, total
 *   fallback)
 * - Chips are correctly shaped
 * - No invented entity names (candidateNames must come from ctx, not LLM)
 * - Edge cases: empty rawText, missing all fields
 */

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildClarification,
} = require("../../src/lib/clarification-fallback.ts");

// ── Helper ────────────────────────────────────────────────────────────────

function assertChipShape(chips) {
  assert.ok(Array.isArray(chips), "chips must be an array");
  for (const chip of chips) {
    assert.ok(typeof chip.label === "string", "chip.label must be string");
    assert.ok(typeof chip.value === "string", "chip.value must be string");
    assert.ok(chip.label.length <= 40, `chip label too long: "${chip.label}"`);
    assert.ok(chip.label.length > 0, "chip label must not be empty");
    assert.ok(chip.value.length > 0, "chip value must not be empty");
  }
  assert.ok(chips.length <= 4, "max 4 chips for clarification context");
}

// ── 1. Capability gap — MercadoPago ──────────────────────────────────────

test("capability gap: mercadopago_not_connected → warm MP setup prompt", () => {
  const result = buildClarification({
    capabilityGap: "mercadopago_not_connected",
    rawText: "link de pago a felix",
  });
  assert.ok(result.text.length > 0, "text must not be empty");
  assert.ok(
    result.text.toLowerCase().includes("mercadopago") ||
      result.text.toLowerCase().includes("mercado pago"),
    "text must mention MercadoPago",
  );
  assert.ok(!result.text.toLowerCase().includes("disculp"), "must not apologize");
  assert.ok(result.chips, "must have chips");
  assertChipShape(result.chips);
  // Must have a 'skip' option per Shopify dismissible pattern
  const hasSkip = result.chips.some(
    (c) =>
      c.value.includes("omitir") ||
      c.value.includes("later") ||
      c.value.includes("tarde"),
  );
  assert.ok(hasSkip, "must offer a skip/later option");
});

// ── 2. Capability gap — Andreani ─────────────────────────────────────────

test("capability gap: andreani_not_connected → Andreani setup prompt", () => {
  const result = buildClarification({
    capabilityGap: "andreani_not_connected",
    rawText: "cotizar envío",
  });
  assert.ok(
    result.text.toLowerCase().includes("andreani"),
    "text must mention Andreani",
  );
  assert.ok(!result.text.toLowerCase().includes("disculp"), "must not apologize");
  assert.ok(result.chips);
  assertChipShape(result.chips);
});

// ── 3. Capability gap — ARCA ─────────────────────────────────────────────

test("capability gap: arca_not_connected → AFIP/CUIT setup prompt", () => {
  const result = buildClarification({
    capabilityGap: "arca_not_connected",
    rawText: "facturame esto",
  });
  assert.ok(
    result.text.toLowerCase().includes("cuit") ||
      result.text.toLowerCase().includes("afip"),
    "text must mention CUIT/AFIP",
  );
  assert.ok(result.chips);
  assertChipShape(result.chips);
});

// ── 4. Capability gap — unknown gap ──────────────────────────────────────

test("capability gap: unknown gap → generic setup prompt, not apology", () => {
  const result = buildClarification({
    capabilityGap: "some_future_gap",
    rawText: "hacer algo",
  });
  assert.ok(result.text.length > 0);
  assert.ok(!result.text.toLowerCase().includes("disculp"), "must not apologize");
  assert.ok(result.chips);
  assertChipShape(result.chips);
});

// ── 5. Both product + customer missing, no fuzzy match ───────────────────

test("both missing + no fuzzy → offers create product / add customer / rephrase", () => {
  const result = buildClarification({
    missingEntities: ["product", "customer"],
    rawText: "mandale 4 alfajores a felix",
  });
  assert.ok(!result.text.toLowerCase().includes("disculp"), "must not apologize");
  assert.ok(result.text.length > 0);
  // Must mention both are missing or ask what to create first
  assert.ok(
    result.text.toLowerCase().includes("product") ||
      result.text.toLowerCase().includes("cliente") ||
      result.text.toLowerCase().includes("creamos"),
    "text must convey both are missing",
  );
  assert.ok(result.chips);
  assertChipShape(result.chips);
  assert.ok(result.chips.length >= 2, "must offer at least 2 resolution paths");
});

// ── 6. Both missing + fuzzy match for product ────────────────────────────

test("both missing + fuzzy match → offers did-you-mean with candidate name", () => {
  const result = buildClarification({
    missingEntities: ["product", "customer"],
    candidateNames: ["Alfajores Guaymallén"],
    rawText: "mandale 4 alfajores a felix",
  });
  assert.ok(
    result.text.includes("Alfajores Guaymallén"),
    "text must include the fuzzy candidate name from ctx",
  );
  assert.ok(!result.text.includes("undefined"), "no undefined leakage");
  assert.ok(result.chips);
  assertChipShape(result.chips);
  // Candidate name must come from ctx.candidateNames, not invented
  const chipValues = result.chips.map((c) => c.value);
  const mentionsCandidate = chipValues.some((v) =>
    v.includes("Alfajores Guaymallén"),
  );
  assert.ok(mentionsCandidate, "chip value must reference the actual candidate");
});

// ── 7. Product missing only, no fuzzy ─────────────────────────────────────

test("product missing, no fuzzy → create or rephrase chips", () => {
  const result = buildClarification({
    missingEntities: ["product"],
    rawText: "vender 5 inexistente",
  });
  assert.ok(!result.text.toLowerCase().includes("disculp"), "must not apologize");
  assert.ok(result.chips);
  assertChipShape(result.chips);
  const chipValues = result.chips.map((c) => c.value);
  const hasCreate = chipValues.some(
    (v) => v.includes("crear") || v.includes("product"),
  );
  assert.ok(hasCreate, "must offer create product option");
});

// ── 8. Product missing only, with fuzzy match ────────────────────────────

test("product missing + fuzzy match → did-you-mean with candidate name", () => {
  const result = buildClarification({
    missingEntities: ["product"],
    candidateNames: ["Galletitas Oreo"],
    rawText: "vender galletitas",
  });
  assert.ok(
    result.text.includes("Galletitas Oreo"),
    "text must include the actual fuzzy candidate",
  );
  assert.ok(result.chips);
  assertChipShape(result.chips);
  const hasSi = result.chips.some(
    (c) => c.label.toLowerCase().includes("sí") || c.label.toLowerCase().includes("si"),
  );
  assert.ok(hasSi, "must have a confirm chip");
});

// ── 9. Customer missing only, no fuzzy ───────────────────────────────────

test("customer missing, no fuzzy → load customer or rephrase chips", () => {
  const result = buildClarification({
    missingEntities: ["customer"],
    rawText: "cobrarle a maria",
  });
  assert.ok(!result.text.toLowerCase().includes("disculp"), "must not apologize");
  assert.ok(result.text.toLowerCase().includes("maria"), "text should mention the fragment");
  assert.ok(result.chips);
  assertChipShape(result.chips);
});

// ── 10. Customer missing + fuzzy match ───────────────────────────────────

test("customer missing + fuzzy match → did-you-mean with candidate", () => {
  const result = buildClarification({
    missingEntities: ["customer"],
    candidateNames: ["María García"],
    rawText: "cobrarle a maria",
  });
  assert.ok(result.text.includes("María García"), "must include candidate name");
  assert.ok(result.chips);
  assertChipShape(result.chips);
});

// ── 11. Total fallback — no entities, no gap ─────────────────────────────

test("total fallback → action menu chips, no apology", () => {
  const result = buildClarification({
    rawText: "asdfasdf xyz zzz",
  });
  assert.ok(!result.text.toLowerCase().includes("disculp"), "must not apologize");
  assert.ok(result.text.length > 0);
  assert.ok(result.chips);
  assertChipShape(result.chips);
  assert.ok(result.chips.length >= 3, "total fallback must offer at least 3 common actions");
});

// ── 12. Edge: empty rawText ───────────────────────────────────────────────

test("edge: empty rawText → total fallback, no crash", () => {
  const result = buildClarification({ rawText: "" });
  assert.ok(result.text.length > 0, "must still produce a response");
  assert.ok(result.chips);
  assertChipShape(result.chips);
});

// ── 13. Edge: missing all optional fields ────────────────────────────────

test("edge: no optional fields → total fallback", () => {
  const result = buildClarification({ rawText: "algo raro" });
  assert.ok(result.text.length > 0);
  assert.ok(!result.text.toLowerCase().includes("disculp"), "no apology");
});

// ── 14. Response is non-vacuous in all branches ───────────────────────────

test("all branches produce non-vacuous text (length > 10)", () => {
  const cases = [
    buildClarification({ capabilityGap: "mercadopago_not_connected", rawText: "x" }),
    buildClarification({ capabilityGap: "andreani_not_connected", rawText: "x" }),
    buildClarification({ capabilityGap: "arca_not_connected", rawText: "x" }),
    buildClarification({ missingEntities: ["product", "customer"], rawText: "mandar alfajores a felix" }),
    buildClarification({ missingEntities: ["product"], rawText: "vender X" }),
    buildClarification({ missingEntities: ["customer"], rawText: "cobrarle a Y" }),
    buildClarification({ rawText: "garbage input" }),
  ];
  for (const r of cases) {
    assert.ok(r.text.length > 10, `too short: "${r.text}"`);
    assert.ok(!r.text.toLowerCase().includes("disculp"), `apology found: "${r.text}"`);
  }
});
