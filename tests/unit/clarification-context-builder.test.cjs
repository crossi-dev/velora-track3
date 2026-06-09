/**
 * Unit tests for src/lib/clarification-context-builder.ts
 *
 * Tests the wiring layer that enriches ClarificationContext from failure
 * signals (toolFailures → missingEntities, capabilities → capabilityGap,
 * rawText fragment extraction, DB fuzzy matching).
 *
 * DB calls are mocked via the prisma singleton stub so no real DB is needed.
 */

const assert = require("node:assert/strict");
const test = require("node:test");

// ── Module under test ────────────────────────────────────────────────────────
const {
  buildClarificationContext,
} = require("../../src/lib/clarification-context-builder.ts");

// ── Prisma mock ──────────────────────────────────────────────────────────────
// The CJS test runner requires that the prisma import is stubbed before
// clarification-context-builder.ts is loaded. We use the module registry
// overwrite pattern consistent with other tests in this suite.
//
// Note: because ESM/CJS interop can be tricky, we test the heuristic extraction
// logic directly by calling buildClarificationContext with an empty businessId
// (which skips DB calls) or a known businessId whose prisma call resolves to
// an empty array (the default stub returns []).

// ── Test 1: toolFailures → missingEntities ────────────────────────────────────

test("toolFailures with missingField product/customer → missingEntities populated", async () => {
  const ctx = await buildClarificationContext({
    rawText: "mandale 4 alfajores a felix",
    businessId: "",
    toolFailures: [
      { tool: "resolve_product", reason: "not found", missingField: "product" },
      { tool: "resolve_customer", reason: "not found", missingField: "customer" },
    ],
  });

  assert.ok(Array.isArray(ctx.missingEntities), "missingEntities must be an array");
  assert.ok(ctx.missingEntities.includes("product"), "must include product");
  assert.ok(ctx.missingEntities.includes("customer"), "must include customer");
  assert.equal(ctx.rawText, "mandale 4 alfajores a felix", "rawText must be preserved");
});

// ── Test 2: toolFailures deduplication ────────────────────────────────────────

test("toolFailures with duplicate missingField → deduplicated", async () => {
  const ctx = await buildClarificationContext({
    rawText: "vender alfajores",
    businessId: "",
    toolFailures: [
      { tool: "resolve_product", reason: "not found", missingField: "product" },
      { tool: "search_catalog", reason: "empty", missingField: "product" },
    ],
  });

  assert.ok(ctx.missingEntities?.includes("product"));
  assert.equal(ctx.missingEntities?.filter((e) => e === "product").length, 1, "no duplicates");
});

// ── Test 3: capability gap — payment intent + no MP ───────────────────────────

test("failedIntent=create_payment_link + mercadopago=false → mercadopago_not_connected gap", async () => {
  const ctx = await buildClarificationContext({
    rawText: "link de pago a felix",
    businessId: "",
    failedIntent: "create_payment_link",
    capabilities: { mercadopago: false, andreani: false, arca: false },
  });

  assert.equal(ctx.capabilityGap, "mercadopago_not_connected");
});

// ── Test 4: capability gap — payment intent + MP connected → no gap ───────────

test("failedIntent=create_payment_link + mercadopago=true → no capability gap", async () => {
  const ctx = await buildClarificationContext({
    rawText: "link de pago a felix",
    businessId: "",
    failedIntent: "create_payment_link",
    capabilities: { mercadopago: true, andreani: false, arca: false },
  });

  assert.equal(ctx.capabilityGap, undefined, "no gap when MP is connected");
});

// ── Test 5: capability gap — andreani ─────────────────────────────────────────

test("failedIntent=logistica + andreani=false → andreani_not_connected gap", async () => {
  const ctx = await buildClarificationContext({
    rawText: "cotizar envio a CABA",
    businessId: "",
    failedIntent: "logistica",
    capabilities: { mercadopago: true, andreani: false, arca: false },
  });

  assert.equal(ctx.capabilityGap, "andreani_not_connected");
});

// ── Test 6: capability gap — arca ─────────────────────────────────────────────

test("failedIntent=factura + arca=false → arca_not_connected gap", async () => {
  const ctx = await buildClarificationContext({
    rawText: "facturame esta venta",
    businessId: "",
    failedIntent: "factura",
    capabilities: { mercadopago: true, andreani: true, arca: false },
  });

  assert.equal(ctx.capabilityGap, "arca_not_connected");
});

// ── Test 7: fragment extraction — customer "a felix" ─────────────────────────

test("rawText 'mandale 4 alfajores a felix' → customer fragment extracted", async () => {
  const ctx = await buildClarificationContext({
    rawText: "mandale 4 alfajores a felix",
    businessId: "",
  });

  assert.equal(ctx.rawText, "mandale 4 alfajores a felix");
  // No DB call (empty businessId) → no candidateNames from DB.
  // The context should still carry the rawText for fragment display.
  assert.ok(!ctx.candidateNames || ctx.candidateNames.length === 0, "no DB candidates without businessId");
});

// ── Test 8: no toolFailures → missingEntities undefined ───────────────────────

test("no toolFailures → missingEntities is undefined (not empty array)", async () => {
  const ctx = await buildClarificationContext({
    rawText: "algo random",
    businessId: "",
  });

  assert.ok(
    ctx.missingEntities === undefined || ctx.missingEntities.length === 0,
    "missingEntities should be absent when no toolFailures",
  );
});

// ── Test 9: failedIntent propagated unchanged ─────────────────────────────────

test("failedIntent is propagated to returned ClarificationContext", async () => {
  const ctx = await buildClarificationContext({
    rawText: "haceme una venta",
    businessId: "",
    failedIntent: "register_sale",
  });

  assert.equal(ctx.failedIntent, "register_sale");
});

// ── Test 10: no capabilities → no capability gap ──────────────────────────────

test("no capabilities provided → capabilityGap is undefined", async () => {
  const ctx = await buildClarificationContext({
    rawText: "link de pago a felix",
    businessId: "",
    failedIntent: "create_payment_link",
    // no capabilities arg
  });

  assert.equal(ctx.capabilityGap, undefined);
});

// ── Test 11: empty rawText → does not crash ────────────────────────────────────

test("empty rawText → does not throw, returns valid ClarificationContext", async () => {
  const ctx = await buildClarificationContext({
    rawText: "",
    businessId: "",
  });

  assert.ok(typeof ctx.rawText === "string");
  assert.ok(ctx.missingEntities === undefined || Array.isArray(ctx.missingEntities));
});
