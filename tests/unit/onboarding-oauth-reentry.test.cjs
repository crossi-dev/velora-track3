"use strict";
// Unit tests for detectConnectedFlip + buildOAuthAck + normalizeWhatsappPhoneSetFromRaw
// + claimOAuthAck (design §6/§14.8).
// OAuth re-entry handshake: detects when an integration just connected
// (false in cached state → true in fresh read) and returns an ack string.
// Cross-instance dedup: claimOAuthAck uses ChatMessage P2002 to guarantee at-most-once.

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

const CAPS_PATH = path.resolve(
  __dirname,
  "../../src/app/api/business-assistant/_lib/owner-handler.stages-onboarding-agent.capabilities.ts",
);

const {
  detectConnectedFlip,
  buildOAuthAck,
  normalizeWhatsappPhoneSetFromRaw,
} = require(CAPS_PATH);

// ── detectConnectedFlip ───────────────────────────────────────────────────────

test("detectConnectedFlip: returns null when nothing changed", () => {
  const caps = { mercadoPagoConnected: false, arcaCertConnected: false, courierCredentialsConnected: false, whatsappPhoneSet: false };
  assert.equal(detectConnectedFlip(caps, caps), null);
});

test("detectConnectedFlip: returns null when all are already connected (no flip)", () => {
  const caps = { mercadoPagoConnected: true, arcaCertConnected: true, courierCredentialsConnected: true, whatsappPhoneSet: true };
  assert.equal(detectConnectedFlip(caps, caps), null);
});

test("detectConnectedFlip: detects mercadopago flip (false→true)", () => {
  const cached = { mercadoPagoConnected: false, arcaCertConnected: false, courierCredentialsConnected: false, whatsappPhoneSet: false };
  const fresh  = { ...cached, mercadoPagoConnected: true };
  assert.equal(detectConnectedFlip(cached, fresh), "mercadopago");
});

test("detectConnectedFlip: detects arca flip (false→true)", () => {
  const cached = { mercadoPagoConnected: false, arcaCertConnected: false, courierCredentialsConnected: false, whatsappPhoneSet: false };
  const fresh  = { ...cached, arcaCertConnected: true };
  assert.equal(detectConnectedFlip(cached, fresh), "arca");
});

test("detectConnectedFlip: detects courier flip (false→true)", () => {
  const cached = { mercadoPagoConnected: false, arcaCertConnected: false, courierCredentialsConnected: false, whatsappPhoneSet: false };
  const fresh  = { ...cached, courierCredentialsConnected: true };
  assert.equal(detectConnectedFlip(cached, fresh), "courier");
});

test("detectConnectedFlip: detects whatsapp flip (false→true)", () => {
  const cached = { mercadoPagoConnected: false, arcaCertConnected: false, courierCredentialsConnected: false, whatsappPhoneSet: false };
  const fresh  = { ...cached, whatsappPhoneSet: true };
  assert.equal(detectConnectedFlip(cached, fresh), "whatsapp");
});

test("detectConnectedFlip: priority — mercadopago before arca when both flip", () => {
  const cached = { mercadoPagoConnected: false, arcaCertConnected: false, courierCredentialsConnected: false, whatsappPhoneSet: false };
  const fresh  = { mercadoPagoConnected: true, arcaCertConnected: true, courierCredentialsConnected: false, whatsappPhoneSet: false };
  assert.equal(detectConnectedFlip(cached, fresh), "mercadopago");
});

test("detectConnectedFlip: true→false does NOT count as a flip", () => {
  const cached = { mercadoPagoConnected: true, arcaCertConnected: false, courierCredentialsConnected: false, whatsappPhoneSet: false };
  const fresh  = { ...cached, mercadoPagoConnected: false };
  assert.equal(detectConnectedFlip(cached, fresh), null);
});

// ── buildOAuthAck ─────────────────────────────────────────────────────────────

test("buildOAuthAck: mercadopago returns Spanish ack with MP mention", () => {
  const ack = buildOAuthAck("mercadopago");
  assert.ok(typeof ack === "string" && ack.length > 0, "ack must be non-empty string");
  assert.ok(ack.toLowerCase().includes("mercado pago") || ack.toLowerCase().includes("mp"), "must mention MP");
});

test("buildOAuthAck: arca returns Spanish ack with AFIP/ARCA mention", () => {
  const ack = buildOAuthAck("arca");
  assert.ok(ack.toLowerCase().includes("afip") || ack.toLowerCase().includes("arca"), "must mention AFIP or ARCA");
});

test("buildOAuthAck: courier returns Spanish ack about shipping", () => {
  const ack = buildOAuthAck("courier");
  assert.ok(ack.toLowerCase().includes("env") || ack.toLowerCase().includes("despachar"), "must mention shipping");
});

test("buildOAuthAck: whatsapp returns Spanish ack mentioning WhatsApp", () => {
  const ack = buildOAuthAck("whatsapp");
  assert.ok(ack.toLowerCase().includes("whatsapp"), "must mention WhatsApp");
});

// ── W3: deferred-sentinel normalization ───────────────────────────────────────
// supCtx.whatsappPhoneSet uses a lenient check (not-null/undefined), so the
// deferred sentinel "" evaluates to true. fetchFreshCapabilities uses strict
// (trim().length > 0), so "" = false. detectConnectedFlip receives the cached
// value already normalized to the strict definition via whatsappPhoneRaw.
// These tests verify the normalized path: "" deferred → real phone fires the ack.

test("W3: detectConnectedFlip: deferred sentinel '' treated as NOT connected (cached=false after normalize)", () => {
  // After W3 normalization the stage sets cached.whatsappPhoneSet = (""trim().length>0) = false.
  // fresh.whatsappPhoneSet = true (real phone) → flip detected.
  const cached = { mercadoPagoConnected: false, arcaCertConnected: false, courierCredentialsConnected: false, whatsappPhoneSet: false };
  const fresh  = { ...cached, whatsappPhoneSet: true };
  assert.equal(detectConnectedFlip(cached, fresh), "whatsapp", "deferred '' → real phone must fire ack");
});

test("W3: detectConnectedFlip: no spurious flip when cached and fresh are both false (both deferred)", () => {
  // Both cached (normalized "") and fresh ("") = false → no flip.
  const cached = { mercadoPagoConnected: false, arcaCertConnected: false, courierCredentialsConnected: false, whatsappPhoneSet: false };
  const fresh  = { ...cached, whatsappPhoneSet: false };
  assert.equal(detectConnectedFlip(cached, fresh), null, "two deferred sentinels must not fire ack");
});

test("W3: detectConnectedFlip: already-real phone does not re-fire ack (cached=true, fresh=true)", () => {
  // A business with a real phone set: both cached and fresh = true → no flip.
  const cached = { mercadoPagoConnected: false, arcaCertConnected: false, courierCredentialsConnected: false, whatsappPhoneSet: true };
  const fresh  = { ...cached };
  assert.equal(detectConnectedFlip(cached, fresh), null, "real phone already set must not re-fire ack");
});

// ── normalizeWhatsappPhoneSetFromRaw ──────────────────────────────────────────
// The stage passes supCtx.whatsappPhoneRaw to this helper to get the strict
// boolean (trim().length > 0) that matches fetchFreshCapabilities, preventing
// the deferred sentinel "" from being treated as "connected" in detectConnectedFlip.

test("normalizeWhatsappPhoneSetFromRaw: deferred sentinel '' yields false", () => {
  // supCtx stores "" as the deferred sentinel; strict check → false.
  assert.equal(
    normalizeWhatsappPhoneSetFromRaw("", true),
    false,
    "empty string must normalize to false regardless of fallback",
  );
});

test("normalizeWhatsappPhoneSetFromRaw: whitespace-only string yields false", () => {
  assert.equal(
    normalizeWhatsappPhoneSetFromRaw("   ", true),
    false,
    "whitespace-only string must normalize to false",
  );
});

test("normalizeWhatsappPhoneSetFromRaw: real phone string yields true", () => {
  assert.equal(
    normalizeWhatsappPhoneSetFromRaw("+5490000000000", false),
    true,
    "real phone must normalize to true",
  );
});

test("normalizeWhatsappPhoneSetFromRaw: non-string (undefined) uses fallback=false", () => {
  // supCtx.whatsappPhoneRaw may be undefined on older DB rows.
  assert.equal(
    normalizeWhatsappPhoneSetFromRaw(undefined, false),
    false,
    "undefined raw must use fallback=false",
  );
});

test("normalizeWhatsappPhoneSetFromRaw: non-string (undefined) uses fallback=true", () => {
  assert.equal(
    normalizeWhatsappPhoneSetFromRaw(undefined, true),
    true,
    "undefined raw must use fallback=true",
  );
});

test("normalizeWhatsappPhoneSetFromRaw: null uses fallback", () => {
  assert.equal(
    normalizeWhatsappPhoneSetFromRaw(null, false),
    false,
    "null raw must use fallback",
  );
});

// ── claimOAuthAck — cross-instance dedup ────────────────────────────────────
// Verifies that claimOAuthAck uses OnboardingOauthAck (NOT ChatMessage):
//   - returns true on first insert (claim succeeded)
//   - returns false on P2002 (another instance already claimed for this slotDate)
//   - propagates unexpected errors (non-P2002)
//
// The dedicated model keeps the token invisible to chat-history and recentAlerts
// queries. slotDate allows reconnect to re-ack the next ART day.

const TODAY_SUMMARY_PATH = require.resolve("@/app/dashboard/lib/today-summary");

function makeClaimPrisma(state) {
  return {
    onboardingOauthAck: {
      create: async (args) => {
        state.createArgs.push(args);
        if (state.throwCode) {
          const err = new Error("DB error");
          err.code = state.throwCode;
          throw err;
        }
        return {};
      },
    },
  };
}

function loadClaimSut(state, slotDateOverride = "2026-06-07") {
  // Clear the capabilities module so prisma + today-summary mocks take effect.
  delete Module._cache[CAPS_PATH];
  const prismaPath = require.resolve("@/lib/prisma");
  delete Module._cache[prismaPath];
  delete Module._cache[TODAY_SUMMARY_PATH];

  // Mock today-summary to return a stable slotDate for deterministic tests.
  Module._cache[TODAY_SUMMARY_PATH] = {
    id: TODAY_SUMMARY_PATH, filename: TODAY_SUMMARY_PATH, loaded: true,
    exports: { getArgentinaDateString: () => slotDateOverride },
  };

  const prismaMock = makeClaimPrisma(state);
  Module._cache[prismaPath] = {
    id: prismaPath, filename: prismaPath, loaded: true,
    exports: { prisma: prismaMock },
  };

  const caps = require(CAPS_PATH);
  return { claimOAuthAck: caps.claimOAuthAck };
}

test("claimOAuthAck: returns true when onboardingOauthAck.create succeeds (first claim)", async () => {
  const state = { createArgs: [], throwCode: null };
  const { claimOAuthAck } = loadClaimSut(state);
  const result = await claimOAuthAck("biz-001", "mercadopago");
  assert.equal(result, true, "first claim must return true");
  assert.equal(state.createArgs.length, 1, "must call onboardingOauthAck.create exactly once");
  assert.equal(state.createArgs[0].data.businessId, "biz-001");
  assert.equal(state.createArgs[0].data.integration, "mercadopago");
  assert.equal(state.createArgs[0].data.slotDate, "2026-06-07", "must use ART slotDate");
});

test("claimOAuthAck: token row has no text/source/visibility (invisible to chat queries)", async () => {
  const state = { createArgs: [], throwCode: null };
  const { claimOAuthAck } = loadClaimSut(state);
  await claimOAuthAck("biz-001", "whatsapp");
  const data = state.createArgs[0].data;
  assert.equal(data.text, undefined, "no text field — invisible to chat history");
  assert.equal(data.source, undefined, "no source field — invisible to recentAlerts");
  assert.equal(data.visibility, undefined, "no visibility field — invisible to chat queries");
});

test("claimOAuthAck: returns false on P2002 (another instance already claimed today)", async () => {
  const state = { createArgs: [], throwCode: "P2002" };
  const { claimOAuthAck } = loadClaimSut(state);
  const result = await claimOAuthAck("biz-001", "whatsapp");
  assert.equal(result, false, "P2002 must return false, not throw");
});

test("claimOAuthAck: propagates unexpected DB errors (not P2002)", async () => {
  const state = { createArgs: [], throwCode: "P1001" };
  const { claimOAuthAck } = loadClaimSut(state);
  await assert.rejects(
    async () => { await claimOAuthAck("biz-001", "arca"); },
    (err) => err.code === "P1001",
    "non-P2002 errors must propagate to caller try/catch",
  );
});

test("claimOAuthAck: uses correct integration name in row for each integration", async () => {
  for (const integration of ["mercadopago", "arca", "courier", "whatsapp"]) {
    const state = { createArgs: [], throwCode: null };
    const { claimOAuthAck } = loadClaimSut(state, "2026-06-07");
    await claimOAuthAck("biz-xyz", integration);
    assert.equal(
      state.createArgs[0].data.integration,
      integration,
      `integration field must match: ${integration}`,
    );
  }
});

test("claimOAuthAck: different slotDate allows re-ack on a new ART day (reconnect scenario)", async () => {
  // Day 1: claim succeeds
  const state1 = { createArgs: [], throwCode: null };
  const { claimOAuthAck: claim1 } = loadClaimSut(state1, "2026-06-07");
  assert.equal(await claim1("biz-001", "mercadopago"), true, "first day: claim succeeds");
  assert.equal(state1.createArgs[0].data.slotDate, "2026-06-07");

  // Day 2: different slotDate → new row, claim succeeds again
  const state2 = { createArgs: [], throwCode: null };
  const { claimOAuthAck: claim2 } = loadClaimSut(state2, "2026-06-08");
  assert.equal(await claim2("biz-001", "mercadopago"), true, "next day: claim succeeds with new slotDate");
  assert.equal(state2.createArgs[0].data.slotDate, "2026-06-08");
});
