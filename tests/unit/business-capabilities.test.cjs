"use strict";

// Unit tests for business-capabilities.ts loader.
//
// Covers:
//   1. Empty business (no connections) → all flags false.
//   2. Unknown businessId → all flags false.
//   3. MP-only → only mercadopago=true.
//   4. WABA + Andreani → whatsapp_business=true, andreani=true; others false.
//   5. Full house → all flags true.
//   6. Encajonado providers (OCA, Correo) → NOT in the returned shape.
//   7. alias whitespace-only → alias_cbu=false.
//   8. whatsappBusinessPhoneE164 empty string → whatsapp_phone=false.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Fake Prisma builder ────────────────────────────────────────────────────

/**
 * Builds a minimal Prisma stub for business-capabilities tests.
 *
 * @param {object|null} bizRow — shape returned by business.findUnique;
 *   null simulates unknown businessId.
 */
function makeFakePrisma(bizRow) {
  return {
    business: {
      findUnique: async () => bizRow,
    },
  };
}

function loadModule(prismaOverride) {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/prisma", { prisma: prismaOverride });
  return require("../../src/lib/business-capabilities.ts");
}

// ── Helper: empty biz row (all connections null / empty) ──────────────────

function emptyBizRow() {
  return {
    whatsappBusinessPhoneE164: null,
    alias: null,
    wabaConnection: null,
    mpConnection: null,
    arcaCredential: null,
    courierCredentials: [],
  };
}

// ── 1. Empty business → all false ─────────────────────────────────────────

test("empty business → all capability flags false", async () => {
  const fakePrisma = makeFakePrisma(emptyBizRow());
  const { loadBusinessCapabilities } = loadModule(fakePrisma);

  const caps = await loadBusinessCapabilities("biz_empty");

  assert.equal(caps.whatsapp_business, false);
  assert.equal(caps.whatsapp_phone, false);
  assert.equal(caps.mercadopago, false);
  assert.equal(caps.alias_cbu, false);
  assert.equal(caps.arca, false);
  assert.equal(caps.andreani, false);
});

// ── 2. Unknown businessId → all false ─────────────────────────────────────

test("unknown businessId → all capability flags false", async () => {
  const fakePrisma = makeFakePrisma(null);
  const { loadBusinessCapabilities } = loadModule(fakePrisma);

  const caps = await loadBusinessCapabilities("biz_does_not_exist");

  assert.equal(caps.whatsapp_business, false);
  assert.equal(caps.whatsapp_phone, false);
  assert.equal(caps.mercadopago, false);
  assert.equal(caps.alias_cbu, false);
  assert.equal(caps.arca, false);
  assert.equal(caps.andreani, false);
});

// ── 3. MP only → only mercadopago=true ────────────────────────────────────

test("MP-only business → only mercadopago=true", async () => {
  const bizRow = {
    ...emptyBizRow(),
    mpConnection: { id: "mp1" },
  };
  const fakePrisma = makeFakePrisma(bizRow);
  const { loadBusinessCapabilities } = loadModule(fakePrisma);

  const caps = await loadBusinessCapabilities("biz_mp_only");

  assert.equal(caps.mercadopago, true);
  assert.equal(caps.whatsapp_business, false);
  assert.equal(caps.whatsapp_phone, false);
  assert.equal(caps.alias_cbu, false);
  assert.equal(caps.arca, false);
  assert.equal(caps.andreani, false);
});

// ── 4. WABA + Andreani → two flags true ───────────────────────────────────

test("WABA + Andreani → whatsapp_business + andreani true; others false", async () => {
  const bizRow = {
    ...emptyBizRow(),
    wabaConnection: { id: "waba1" },
    courierCredentials: [{ id: "cc1" }],
  };
  const fakePrisma = makeFakePrisma(bizRow);
  const { loadBusinessCapabilities } = loadModule(fakePrisma);

  const caps = await loadBusinessCapabilities("biz_waba_andreani");

  assert.equal(caps.whatsapp_business, true);
  assert.equal(caps.andreani, true);
  assert.equal(caps.whatsapp_phone, false);
  assert.equal(caps.mercadopago, false);
  assert.equal(caps.alias_cbu, false);
  assert.equal(caps.arca, false);
});

// ── 5. Full house → all flags true ────────────────────────────────────────

test("full house → all capability flags true", async () => {
  const bizRow = {
    whatsappBusinessPhoneE164: "+5491100000000",
    alias: "velora.mp",
    wabaConnection: { id: "waba1" },
    mpConnection: { id: "mp1" },
    arcaCredential: { id: "arca1" },
    courierCredentials: [{ id: "cc1" }],
  };
  const fakePrisma = makeFakePrisma(bizRow);
  const { loadBusinessCapabilities } = loadModule(fakePrisma);

  const caps = await loadBusinessCapabilities("biz_full");

  assert.equal(caps.whatsapp_business, true);
  assert.equal(caps.whatsapp_phone, true);
  assert.equal(caps.mercadopago, true);
  assert.equal(caps.alias_cbu, true);
  assert.equal(caps.arca, true);
  assert.equal(caps.andreani, true);
});

// ── 6. Encajonado providers NOT in shape ──────────────────────────────────

test("returned shape has no OCA or Correo keys (encajonados)", async () => {
  const fakePrisma = makeFakePrisma(emptyBizRow());
  const { loadBusinessCapabilities } = loadModule(fakePrisma);

  const caps = await loadBusinessCapabilities("biz_check_shape");

  assert.ok(!("oca" in caps), "oca must not be in BusinessCapabilities shape");
  assert.ok(!("correo" in caps), "correo must not be in BusinessCapabilities shape");
});

// ── 7. Alias whitespace-only → alias_cbu=false ───────────────────────────

test("alias whitespace-only → alias_cbu=false", async () => {
  const bizRow = { ...emptyBizRow(), alias: "   " };
  const fakePrisma = makeFakePrisma(bizRow);
  const { loadBusinessCapabilities } = loadModule(fakePrisma);

  const caps = await loadBusinessCapabilities("biz_alias_ws");

  assert.equal(caps.alias_cbu, false);
});

// ── 8. whatsappBusinessPhoneE164 empty string → whatsapp_phone=false ──────

test("whatsappBusinessPhoneE164 empty string → whatsapp_phone=false", async () => {
  const bizRow = { ...emptyBizRow(), whatsappBusinessPhoneE164: "" };
  const fakePrisma = makeFakePrisma(bizRow);
  const { loadBusinessCapabilities } = loadModule(fakePrisma);

  const caps = await loadBusinessCapabilities("biz_phone_empty");

  assert.equal(caps.whatsapp_phone, false);
});
