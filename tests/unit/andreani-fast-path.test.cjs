// Unit tests — Andreani Fast Path detector + real-mode executor passthrough.
//
// Part 1: detectAndreaniIntent (pure string matching)
//   - PAYMENT_LINK_EXCLUSION_RE: payment-link phrases must return null
//   - quote / create / track detection
//   - short input / empty → null
//
// Part 2: executeAndreaniIntent in REAL mode (ANDREANI_MOCK_MODE absent/false)
//   - must return null so the Supervisor routes to the real Logística agent
//   - hardcoded prices must NEVER be returned in real mode
//
// Both parts use NO DB and NO network. Part 2 mocks only the two
// infrastructure imports (next/server, cloud-logger) that the executor uses.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Part 1 — detectAndreaniIntent (pure, no mocks needed) ─────────────────────

const {
  detectAndreaniIntent,
} = require("../../src/app/api/business-assistant/_lib/nlu/andreani-fast-path.ts");

// PAYMENT_LINK_EXCLUSION_RE — must not intercept Payments agent traffic
test("exclusion: 'generá un link de pago con envío' → null (belongs to Payments agent)", () => {
  assert.strictEqual(detectAndreaniIntent("generá un link de pago con envío"), null);
});

test("exclusion: 'link de cobro para 3 filtros' → null", () => {
  assert.strictEqual(detectAndreaniIntent("link de cobro para 3 filtros"), null);
});

test("exclusion: 'generar link para Juan con flete' → null", () => {
  assert.strictEqual(detectAndreaniIntent("generar link para Juan con flete"), null);
});

test("exclusion: 'crear un link con envío' → null", () => {
  assert.strictEqual(detectAndreaniIntent("crear un link con envío"), null);
});

// shipment.quote detection
test("quote: 'cuánto cuesta enviar a 5500' → shipment.quote", () => {
  const r = detectAndreaniIntent("cuánto cuesta enviar a 5500");
  assert.ok(r !== null);
  assert.strictEqual(r.skill, "shipment.quote");
});

test("quote: 'cotizame el envío a Mendoza' → shipment.quote", () => {
  const r = detectAndreaniIntent("cotizame el envío a Mendoza");
  assert.ok(r !== null);
  assert.strictEqual(r.skill, "shipment.quote");
});

test("quote: 'precio del flete al CP 1043' → shipment.quote + postalCode extracted", () => {
  const r = detectAndreaniIntent("precio del flete al CP 1043");
  assert.ok(r !== null);
  assert.strictEqual(r.skill, "shipment.quote");
  assert.strictEqual(r.postalCode, "5500");
});

// shipment.create detection
test("create: 'generá la etiqueta' → shipment.create", () => {
  const r = detectAndreaniIntent("generá la etiqueta");
  assert.ok(r !== null);
  assert.strictEqual(r.skill, "shipment.create");
});

test("create: 'creá un envío para esta venta' → shipment.create", () => {
  const r = detectAndreaniIntent("creá un envío para esta venta");
  assert.ok(r !== null);
  assert.strictEqual(r.skill, "shipment.create");
});

// shipment.track detection
test("track: 'tracking ARK-1234567' → shipment.track + trackingCode extracted", () => {
  const r = detectAndreaniIntent("tracking ARK-1234567");
  assert.ok(r !== null);
  assert.strictEqual(r.skill, "shipment.track");
  assert.match(r.trackingCode ?? "", /ARK-/i);
});

test("track: 'cómo va el envío ARK-ABCD123' → shipment.track", () => {
  const r = detectAndreaniIntent("cómo va el envío ARK-ABCD123");
  assert.ok(r !== null);
  assert.strictEqual(r.skill, "shipment.track");
});

// ── Deterministic track extraction — new patterns (Task Tier-3, 2026-05-30) ──
// Source: https://adk.dev/agents/workflow-agents — template agents determine
// execution sequence without consulting an AI model for orchestration.

test("track: '¿dónde está mi envío?' → shipment.track (was LLM-path before fix)", () => {
  const r = detectAndreaniIntent("¿dónde está mi envío?");
  assert.ok(r !== null, "should detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
  assert.strictEqual(r.trackingCode, null);
});

test("track: 'seguimiento del paquete' → shipment.track (was LLM-path before fix)", () => {
  const r = detectAndreaniIntent("seguimiento del paquete");
  assert.ok(r !== null, "should detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
});

test("track: 'seguimiento del pedido' → shipment.track", () => {
  const r = detectAndreaniIntent("seguimiento del pedido");
  assert.ok(r !== null, "should detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
});

test("track: 'seguimiento del envío' → shipment.track", () => {
  const r = detectAndreaniIntent("seguimiento del envío");
  assert.ok(r !== null, "should detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
});

test("track: 'trackeá NNNNN' (verb, no valid code) → shipment.track, trackingCode null", () => {
  const r = detectAndreaniIntent("trackeá NNNNN");
  assert.ok(r !== null, "should detect as shipment.track via verb");
  assert.strictEqual(r.skill, "shipment.track");
  assert.strictEqual(r.trackingCode, null);
});

test("track: 'donde esta mi envio' → shipment.track (no diacritics)", () => {
  const r = detectAndreaniIntent("donde esta mi envio");
  assert.ok(r !== null, "should detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
});

test("track: 'donde queda el paquete' → shipment.track", () => {
  const r = detectAndreaniIntent("donde queda el paquete");
  assert.ok(r !== null, "should detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
});

test("track: 'quiero el seguimiento del paquete ARK-9876543' → shipment.track + code extracted", () => {
  const r = detectAndreaniIntent("quiero el seguimiento del paquete ARK-9876543");
  assert.ok(r !== null, "should detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
  assert.strictEqual(r.trackingCode, "ARK-9876543");
});

test("track: 'trackear el paquete' → shipment.track", () => {
  const r = detectAndreaniIntent("trackear el paquete");
  assert.ok(r !== null, "should detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
});

// Negative: "seguimiento del" without a matching noun should NOT match
test("track: 'seguimiento del cliente' → null (noun not in track list)", () => {
  assert.strictEqual(detectAndreaniIntent("seguimiento del cliente"), null);
});

test("track: 'donde esta juan' → null (no envio/paquete)", () => {
  assert.strictEqual(detectAndreaniIntent("donde esta juan"), null);
});

// ── False-positive guard — must NOT route to shipment.track ──────────────────
// Regression tests for the secondary shipping-qualifier guard.
// "estado del pedido" without a shipping noun/qualifier is a sales/purchase
// order status query and must fall through to the Supervisor.
// Bare "rastrear" without a shipping object is similarly ambiguous.

test("track guard: 'estado del pedido de compra' → null (purchase order, no shipping noun)", () => {
  assert.strictEqual(
    detectAndreaniIntent("¿cuál es el estado del pedido de compra?"),
    null,
    "purchase-order status must not route to shipment.track",
  );
});

test("track guard: 'estado del pedido de Juan' → null (sales order status, no shipping noun)", () => {
  assert.strictEqual(
    detectAndreaniIntent("estado del pedido de Juan"),
    null,
    "sales-order status without shipping context must not route to shipment.track",
  );
});

test("track guard: 'rastrear mis gastos' → null (non-shipping rastrear)", () => {
  assert.strictEqual(
    detectAndreaniIntent("rastrear mis gastos"),
    null,
    "rastrear with no shipping object must not route to shipment.track",
  );
});

test("track guard: bare 'rastrear' → null (no shipping object)", () => {
  assert.strictEqual(
    detectAndreaniIntent("rastrear"),
    null,
    "bare rastrear must not route to shipment.track",
  );
});

// trackea-verb family self-qualifies — restored by FIX 1 (2026-05-31)
// "trackeame", "trackealo" are unambiguous AR shipping verbs (borrowed English
// "track") and must route to shipment.track without any additional ship noun.
// Bare "rastrear" remains non-self-qualifying (see guard tests above).

test("track: bare 'trackeame' → shipment.track (self-qualifies, no ship noun needed)", () => {
  const r = detectAndreaniIntent("trackeame");
  assert.ok(r !== null, "trackeame must detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
  assert.strictEqual(r.trackingCode, null);
});

test("track: 'trackealo' → shipment.track (self-qualifies)", () => {
  const r = detectAndreaniIntent("trackealo");
  assert.ok(r !== null, "trackealo must detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
  assert.strictEqual(r.trackingCode, null);
});

// Must-fire: these must still detect as shipment.track after the guard fix
test("track must-fire: 'rastrear mi envío' → shipment.track (envio qualifies)", () => {
  const r = detectAndreaniIntent("rastrear mi envío");
  assert.ok(r !== null, "rastrear mi envío must detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
});

test("track must-fire: 'rastrear mi paquete' → shipment.track (paquete qualifies)", () => {
  const r = detectAndreaniIntent("rastrear mi paquete");
  assert.ok(r !== null, "rastrear mi paquete must detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
});

test("track must-fire: '¿dónde está mi paquete?' → shipment.track", () => {
  const r = detectAndreaniIntent("¿dónde está mi paquete?");
  assert.ok(r !== null, "donde esta mi paquete must detect as shipment.track");
  assert.strictEqual(r.skill, "shipment.track");
});

// mandale fast-path (shipment.create via "mandale el pedido/paquete/envío a X")
test("mandale: 'mandale el pedido a juan por andreani' → shipment.create + customerName=juan", () => {
  const r = detectAndreaniIntent("mandale el pedido a juan por andreani");
  assert.ok(r !== null, "should match");
  assert.strictEqual(r.skill, "shipment.create");
  assert.strictEqual(r.customerName?.toLowerCase(), "juan");
});

test("mandale: 'mandale el menú a juan' → null (no ship noun, no courier)", () => {
  // 'menú' is not a ship noun — should fall to LLM
  assert.strictEqual(detectAndreaniIntent("mandale el menú a juan"), null);
});

test("mandale: 'mandale el paquete a juan' → shipment.create (paquete is ship noun)", () => {
  const r = detectAndreaniIntent("mandale el paquete a juan");
  assert.ok(r !== null, "should match");
  assert.strictEqual(r.skill, "shipment.create");
  assert.strictEqual(r.customerName?.toLowerCase(), "juan");
});

test("mandale: 'mandale el envío a juan por OCA' → shipment.create + courier detected", () => {
  const r = detectAndreaniIntent("mandale el envío a juan por OCA");
  assert.ok(r !== null, "should match");
  assert.strictEqual(r.skill, "shipment.create");
  assert.strictEqual(r.customerName?.toLowerCase(), "juan");
});

// Edge cases
test("empty string → null", () => {
  assert.strictEqual(detectAndreaniIntent(""), null);
});

test("very short input (< 5 chars) → null", () => {
  assert.strictEqual(detectAndreaniIntent("env"), null);
});

test("unrelated input → null", () => {
  assert.strictEqual(detectAndreaniIntent("vendé 5 tuercas a Juan"), null);
});

// ── Part 2 — executeAndreaniIntent in REAL mode → returns null ────────────────
//
// In real mode (ANDREANI_MOCK_MODE not 'true'), the executor MUST return null
// so the Supervisor routes to the real Logística agent instead of using
// hard-coded mock prices.

function makeNextResponseMock() {
  return {
    NextResponse: {
      json: (body) => ({ _isMock: true, body }),
    },
  };
}

function loadExecutor() {
  resetSourceModules();
  clearMockModules();
  setMockModule("next/server", makeNextResponseMock());
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  // isAndreaniMockActive is imported from andreani-mock — mock it as returning false
  // (non-demo business, real mode). We resolve to the actual module path so the
  // mock hook intercepts it.
  setMockModule(
    "@/app/api/agents/andreani/_lib/andreani-mock",
    { isAndreaniMockActive: () => false },
  );
  // Mock prisma so the postal-code guard (which queries business.postalCode)
  // returns a fully-populated business — prevents the DB call in unit tests.
  setMockModule("@/lib/prisma", {
    prisma: {
      business: {
        findUnique: async () => ({
          postalCode: "5500",
          paymentProvider: "mp",
          alias: "velora.demo",
          whatsappPhone: "+541155551234",
          cuit: "20123456789",
        }),
      },
    },
  });
  return require("../../src/app/api/business-assistant/_lib/nlu/execute-andreani-fast-path.ts");
}

const OWNER_PARAMS = {
  actorRole: "owner",
  businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
  actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
  actorEmployeeId: null,
  text: "cotizame el envío",
  locale: "es-AR",
  context: { catalog: { customers: [] } },
  recentHistory: [],
  productInfoDirectory: [],
  invoiceDirectory: [],
  purchaseRequestDirectory: [],
};

const QUOTE_INTENT = {
  kind: "andreani_fast_path",
  skill: "shipment.quote",
  destinationHint: "Mendoza",
  postalCode: "5500",
  trackingCode: null,
};

const CREATE_INTENT = {
  kind: "andreani_fast_path",
  skill: "shipment.create",
  destinationHint: null,
  postalCode: null,
  trackingCode: null,
};

const TRACK_INTENT = {
  kind: "andreani_fast_path",
  skill: "shipment.track",
  destinationHint: null,
  postalCode: null,
  trackingCode: "ARK-1234567",
};

test("real mode: executeAndreaniIntent(quote) → null (passthrough to Supervisor)", async () => {
  const { executeAndreaniIntent } = loadExecutor();
  const result = await executeAndreaniIntent(QUOTE_INTENT, OWNER_PARAMS);
  assert.strictEqual(result, null, "real mode must return null for shipment.quote");
});

test("real mode: executeAndreaniIntent(create) → null", async () => {
  const { executeAndreaniIntent } = loadExecutor();
  const result = await executeAndreaniIntent(CREATE_INTENT, OWNER_PARAMS);
  assert.strictEqual(result, null, "real mode must return null for shipment.create");
});

test("real mode: executeAndreaniIntent(track) → null", async () => {
  const { executeAndreaniIntent } = loadExecutor();
  const result = await executeAndreaniIntent(TRACK_INTENT, OWNER_PARAMS);
  assert.strictEqual(result, null, "real mode must return null for shipment.track");
});

// ── Per-business gate: non-demo businessId must hit real path even when global flag is on ─
//
// JD WARNING fix: the execution-layer gate must be isAndreaniMockActive(businessId), not the
// global isMockEnabled(). A non-demo business always gets the real path at execution.
//
// This test simulates the post-fix state: isAndreaniMockActive returns false for a non-demo
// business even if ANDREANI_MOCK_MODE would be true globally, so executeAndreaniIntent returns
// null (real path passthrough) instead of mock prices.

function loadExecutorWithMockActiveReturning(value) {
  resetSourceModules();
  clearMockModules();
  setMockModule("next/server", makeNextResponseMock());
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule(
    "@/app/api/agents/andreani/_lib/andreani-mock",
    { isAndreaniMockActive: () => value },
  );
  setMockModule("@/lib/prisma", {
    prisma: {
      business: {
        findUnique: async () => ({
          postalCode: "5500",
          paymentProvider: "mp",
          alias: "velora.demo",
          whatsappPhone: "+541155551234",
          cuit: "20123456789",
        }),
      },
    },
  });
  return require("../../src/app/api/business-assistant/_lib/nlu/execute-andreani-fast-path.ts");
}

test("per-business gate: non-demo businessId → isAndreaniMockActive returns false → passthrough (real path)", async () => {
  // isAndreaniMockActive returns false = non-demo business; executor must return null
  const { executeAndreaniIntent } = loadExecutorWithMockActiveReturning(false);
  const result = await executeAndreaniIntent(QUOTE_INTENT, OWNER_PARAMS);
  assert.strictEqual(result, null,
    "non-demo business must get null (real path) even when isAndreaniMockActive would be true globally");
});

test("per-business gate: demo businessId → isAndreaniMockActive returns true → mock response returned", async () => {
  // isAndreaniMockActive returns true = demo business; executor must return a mock response (not null)
  const { executeAndreaniIntent } = loadExecutorWithMockActiveReturning(true);
  const result = await executeAndreaniIntent(QUOTE_INTENT, OWNER_PARAMS);
  assert.notStrictEqual(result, null,
    "demo business must get a mock response (not null) when isAndreaniMockActive is true");
  assert.ok(result !== null && typeof result === "object", "result must be an object");
});
