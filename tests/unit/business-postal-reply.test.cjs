"use strict";

// business-postal-reply.test.cjs
//
// Tests for the business_postal_reply deterministic intent:
//   - detectBusinessPostalReply: bare code WITH marker → fires
//   - detectBusinessPostalReply: bare code WITHOUT marker → does NOT fire
//   - detectBusinessPostalReply: non-code message → does NOT fire
//   - detectDeterministicIntent: integration routing via PRIORITY_TABLE

const assert = require("node:assert/strict");
const test = require("node:test");

const { detectBusinessPostalReply, POSTAL_QUESTION_MARKER } = require(
  "../../src/app/api/business-assistant/_lib/nlu/business-postal-reply-fast-path.ts"
);
const { detectDeterministicIntent } = require(
  "../../src/app/api/business-assistant/_lib/nlu/detect.ts"
);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Build a recentHistory array with the last assistant turn containing the marker. */
function historyWithMarker() {
  return [
    { role: "assistant", text: `Antes de generar el link necesito el ${POSTAL_QUESTION_MARKER} — lo uso para cotizar el envío con Andreani. ¿Cuál es el ${POSTAL_QUESTION_MARKER}? (por ejemplo: 5500)` },
  ];
}

/** Build a recentHistory array where the last assistant turn does NOT have the marker. */
function historyWithoutMarker() {
  return [
    { role: "assistant", text: "Listo, registré la venta de 2 coca cola a María García." },
  ];
}

const emptyHistory = [];

// ── detectBusinessPostalReply unit tests ─────────────────────────────────────

test("fires for bare 4-digit code when marker is present in last assistant turn", () => {
  const r = detectBusinessPostalReply("5500", historyWithMarker());
  assert.ok(r, "should detect");
  assert.equal(r.kind, "business_postal_reply");
  assert.equal(r.postalCode, "5500");
});

test("fires for bare 5-digit code when marker is present", () => {
  const r = detectBusinessPostalReply("11200", historyWithMarker());
  assert.ok(r);
  assert.equal(r.postalCode, "11200");
});

test("fires for 'CP 1043' format when marker is present", () => {
  const r = detectBusinessPostalReply("CP 1043", historyWithMarker());
  assert.ok(r);
  assert.equal(r.postalCode, "5500");
});

test("fires for 'cp: 5500' format when marker is present", () => {
  const r = detectBusinessPostalReply("cp: 5500", historyWithMarker());
  assert.ok(r);
  assert.equal(r.postalCode, "5500");
});

test("fires for 'código postal 5500' format when marker is present", () => {
  const r = detectBusinessPostalReply("código postal 5500", historyWithMarker());
  assert.ok(r);
  assert.equal(r.postalCode, "5500");
});

test("does NOT fire when bare code is present but marker is ABSENT from history", () => {
  const r = detectBusinessPostalReply("5500", historyWithoutMarker());
  assert.equal(r, null, "must not fire without history marker");
});

test("does NOT fire when bare code is present but history is empty", () => {
  const r = detectBusinessPostalReply("5500", emptyHistory);
  assert.equal(r, null);
});

test("does NOT fire for a normal sale message even with marker in history", () => {
  const r = detectBusinessPostalReply("vendé 2 coca cola a María", historyWithMarker());
  assert.equal(r, null);
});

test("does NOT fire for a number that is too long (6 digits)", () => {
  const r = detectBusinessPostalReply("123456", historyWithMarker());
  assert.equal(r, null);
});

test("does NOT fire for a 3-digit number", () => {
  const r = detectBusinessPostalReply("550", historyWithMarker());
  assert.equal(r, null);
});

test("does NOT fire for a long prose message containing a postal code", () => {
  const r = detectBusinessPostalReply(
    "el código postal de mi negocio es 5500 y está en Mendoza",
    historyWithMarker()
  );
  assert.equal(r, null, "long message should not match");
});

test("does NOT fire for empty string", () => {
  assert.equal(detectBusinessPostalReply("", historyWithMarker()), null);
  assert.equal(detectBusinessPostalReply("   ", historyWithMarker()), null);
});

// ── Integration: detectDeterministicIntent routing ────────────────────────────

const ownerCtxBase = {
  catalog: {
    products: [{ id: "p1", name: "filtros de aire" }],
    customers: [{ id: "c1", name: "María García" }],
  },
  productInfoDirectory: [{ name: "filtros de aire" }],
  invoiceDirectory: [],
  purchaseRequestDirectory: [],
  actorRole: "owner",
};

test("detectDeterministicIntent: bare CP with marker in ctx.recentHistory → business_postal_reply", () => {
  const ctx = { ...ownerCtxBase, recentHistory: historyWithMarker() };
  const r = detectDeterministicIntent("5500", ctx);
  assert.ok(r, "should not return null");
  assert.equal(r.kind, "business_postal_reply");
});

test("detectDeterministicIntent: bare CP WITHOUT marker → null (falls to LLM)", () => {
  const ctx = { ...ownerCtxBase, recentHistory: historyWithoutMarker() };
  const r = detectDeterministicIntent("5500", ctx);
  // Should not return business_postal_reply (may return null or something else)
  if (r) {
    assert.notEqual(r.kind, "business_postal_reply");
  }
});

test("detectDeterministicIntent: employee with marker → NOT business_postal_reply (owner-only guard)", () => {
  const ctx = { ...ownerCtxBase, actorRole: "employee", recentHistory: historyWithMarker() };
  const r = detectDeterministicIntent("5500", ctx);
  if (r) {
    assert.notEqual(r.kind, "business_postal_reply");
  }
});
