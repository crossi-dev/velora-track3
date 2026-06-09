"use strict";

// Unit tests for AliasCbuAdapter (Fase B3 — alias/CBU transfer provider).
//
// Covers:
//   1. createCollection — alias configured: returns CollectionResult with instructions,
//      no checkoutUrl, no external HTTP call.
//   2. createCollection — no alias: returns { error: "no_alias_configured" }.
//   3. createCollection — alias whitespace-only: treated as empty → no_alias_configured.
//   4. getStatus — estado "pending": maps to status "pending", no external call.
//   5. getStatus — estado "confirmed": maps to status "approved".
//   6. getStatus — unknown estado: maps to status "error".
//   7. getStatus — intent not found: returns status "error" with detail "intent_not_found".

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Constants ─────────────────────────────────────────────────────────────────

const BIZ_ID = "biz1aaaaaaaaaaaaaaaaaaaa";
const PI_ID  = "pi1aaaaaaaaaaaaaaaaaaaa1";

// ── Fake Prisma builders ──────────────────────────────────────────────────────

/** Builds a minimal fake Prisma for AliasCbuAdapter tests. */
function makeFakePrisma({ alias = null, estado = "pending", intentExists = true } = {}) {
  const intents = new Map();
  if (intentExists) intents.set(PI_ID, { id: PI_ID, businessId: BIZ_ID, estado, paymentInstructions: null });

  return {
    business: {
      findUnique: async ({ where }) => {
        if (where.id !== BIZ_ID) return null;
        return { alias };
      },
    },
    paymentIntent: {
      // getStatus uses findFirst({ where: { id, businessId } }) for tenant scoping.
      findFirst: async ({ where }) => {
        if (!intentExists || where.id !== PI_ID) return null;
        if (where.businessId !== undefined && where.businessId !== BIZ_ID) return null;
        return { estado };
      },
      // createCollection persists paymentInstructions via update (best-effort).
      // Stub must not throw or the adapter will silently swallow the error and
      // skip the return value, causing "result is undefined" in the test.
      update: async ({ where, data }) => {
        const row = intents.get(where?.id);
        if (!row) throw new Error(`paymentIntent not found: ${where?.id}`);
        Object.assign(row, data);
        return { ...row };
      },
    },
  };
}

function loadAdapter(prismaOverride) {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/lib/prisma", { prisma: prismaOverride });
  return require(
    "../../src/app/api/agents/payments/jsonrpc/_lib/providers/alias-cbu-adapter.ts"
  );
}

// ── 1. createCollection — alias configured ────────────────────────────────────

test("createCollection — alias configured: returns instructions, no checkoutUrl, no providerRef", async () => {
  const fakePrisma = makeFakePrisma({ alias: "velora.mp" });
  const { AliasCbuAdapter } = loadAdapter(fakePrisma);

  const adapter = new AliasCbuAdapter();
  const result = await adapter.createCollection({
    paymentIntentId: PI_ID,
    amountARS: 5_000,
    description: "Venta test",
    customerName: "Juan Test",
    businessId: BIZ_ID,
  });

  assert.ok(!("error" in result), `should not have error, got: ${JSON.stringify(result)}`);
  assert.equal(result.paymentIntentId, PI_ID);
  assert.equal(result.amountARS, 5_000);
  assert.equal(result.status, "pending");
  assert.equal(result.currency, "ARS");

  // Must include the alias in the instructions text.
  assert.ok(typeof result.instructions === "string", "instructions should be a string");
  assert.ok(result.instructions.includes("velora.mp"), "instructions must mention the alias");

  // URL-based fields must be absent.
  assert.equal(result.checkoutUrl, undefined, "checkoutUrl must not be set");
  assert.equal(result.providerRef,  undefined, "providerRef must not be set");
});

// ── 2. createCollection — no alias ────────────────────────────────────────────

test("createCollection — no alias: returns no_alias_configured error", async () => {
  const fakePrisma = makeFakePrisma({ alias: null });
  const { AliasCbuAdapter } = loadAdapter(fakePrisma);

  const adapter = new AliasCbuAdapter();
  const result = await adapter.createCollection({
    paymentIntentId: PI_ID,
    amountARS: 3_000,
    description: "Venta test",
    businessId: BIZ_ID,
  });

  assert.ok("error" in result, "should return error object");
  assert.equal(result.error, "no_alias_configured");
  assert.ok(typeof result.detail === "string" && result.detail.length > 0, "detail must be a non-empty string");
});

// ── 3. createCollection — whitespace-only alias ───────────────────────────────

test("createCollection — whitespace-only alias: returns no_alias_configured error", async () => {
  const fakePrisma = makeFakePrisma({ alias: "   " });
  const { AliasCbuAdapter } = loadAdapter(fakePrisma);

  const adapter = new AliasCbuAdapter();
  const result = await adapter.createCollection({
    paymentIntentId: PI_ID,
    amountARS: 1_000,
    description: "Venta test",
    businessId: BIZ_ID,
  });

  assert.ok("error" in result);
  assert.equal(result.error, "no_alias_configured");
});

// ── 4. getStatus — estado "pending" ──────────────────────────────────────────

test("getStatus — estado pending: maps to status 'pending'", async () => {
  const fakePrisma = makeFakePrisma({ estado: "pending" });
  const { AliasCbuAdapter } = loadAdapter(fakePrisma);

  const adapter = new AliasCbuAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });

  assert.equal(result.status, "pending");
  assert.equal(result.paymentIntentId, PI_ID);
  assert.equal(result.currency, "ARS");
});

// ── 5. getStatus — estado "confirmed" ────────────────────────────────────────

test("getStatus — estado confirmed: maps to status 'approved'", async () => {
  const fakePrisma = makeFakePrisma({ estado: "confirmed" });
  const { AliasCbuAdapter } = loadAdapter(fakePrisma);

  const adapter = new AliasCbuAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });

  assert.equal(result.status, "approved");
  assert.equal(result.paymentIntentId, PI_ID);
  assert.equal(result.currency, "ARS");
});

// ── 6. getStatus — terminal state "cancelled" ────────────────────────────────

test("getStatus — cancelled: maps to status 'rejected' with detail", async () => {
  const fakePrisma = makeFakePrisma({ estado: "cancelled" });
  const { AliasCbuAdapter } = loadAdapter(fakePrisma);

  const adapter = new AliasCbuAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });

  assert.equal(result.status, "rejected", "cancelled must map to rejected, not error");
  assert.equal(result.detail, "cancelled", "detail must expose the real DB estado");
});

test("getStatus — expired: maps to status 'rejected' with detail", async () => {
  const fakePrisma = makeFakePrisma({ estado: "expired" });
  const { AliasCbuAdapter } = loadAdapter(fakePrisma);

  const adapter = new AliasCbuAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });

  assert.equal(result.status, "rejected", "expired must map to rejected, not error");
  assert.equal(result.detail, "expired");
});

test("getStatus — truly unknown estado: maps to status 'error' with detail", async () => {
  const fakePrisma = makeFakePrisma({ estado: "refunded" });
  const { AliasCbuAdapter } = loadAdapter(fakePrisma);

  const adapter = new AliasCbuAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });

  assert.equal(result.status, "error");
  assert.equal(result.detail, "refunded");
});

// ── 7. getStatus — intent not found ──────────────────────────────────────────

test("getStatus — intent not found: returns error with detail 'intent_not_found'", async () => {
  const fakePrisma = makeFakePrisma({ intentExists: false });
  const { AliasCbuAdapter } = loadAdapter(fakePrisma);

  const adapter = new AliasCbuAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: BIZ_ID });

  assert.equal(result.status, "error");
  assert.equal(result.detail, "intent_not_found");
});

// ── 8. getStatus — cross-tenant isolation ─────────────────────────────────────

test("getStatus — wrong businessId: returns intent_not_found (tenant isolation)", async () => {
  // The DB has a real intent for BIZ_ID but we query with a different businessId.
  const fakePrisma = makeFakePrisma({ estado: "confirmed" });
  const { AliasCbuAdapter } = loadAdapter(fakePrisma);

  const adapter = new AliasCbuAdapter();
  const result = await adapter.getStatus({ paymentIntentId: PI_ID, businessId: "biz-other-aaaaaaaaaaaaa" });

  assert.equal(result.status, "error");
  assert.equal(result.detail, "intent_not_found", "must not return data for a different businessId");
});
