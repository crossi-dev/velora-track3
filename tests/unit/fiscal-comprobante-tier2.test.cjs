"use strict";

// Unit tests for the Fiscal Agent tier-2 comprobante interno path.
//
// Design: Stripe Receipts pattern — always emit a PDF receipt, regardless of
// whether an official ARCA invoice was generated.
// Source: https://stripe.com/docs/receipts
//
// Two branches under test:
//   A. routeFiscalFallback  — ADK returns empty/fallback text (ARCA failed/timeout)
//   B. routeFiscalOwnerOnly — ARCA setup incomplete (setupGuidance present)
//
// In both cases, the functions must:
//   1. Log FISCAL_RECEIPT_TIER2_COMPROBANTE with the correct tier2Reason.
//   2. Call buildAndAttachReceiptPdf to generate a comprobante interno PDF.
//   3. Send the PDF via WhatsApp (sendWhatsAppMessage called with mediaUrl).
//   4. Return { ok: false } (so comprobanteSentAt is rolled back for retry/audit).
//
// Additional tier-1 regression: when ARCA succeeds (happy path in trigger-fiscal-receipt.ts),
// buildAndAttachReceiptPdf is called in the happy path — not via these route helpers.
// This is already covered by fiscal-agent.test.cjs tests 4 and 8.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const BASE_INPUT = {
  paymentIntentId: "pi-test-001",
  businessId: "biz-test-001",
  customerName: "Juan García",
  phone: "+5490000000000",
  agentText: "",
  saleId: "sale-001",
  monto: 1500,
  confirmedAt: new Date("2026-05-27T12:00:00Z"),
};

// ── Loader ────────────────────────────────────────────────────────────────────

/**
 * Loads trigger-fiscal-receipt.routes.ts with controlled mocks.
 * Returns the module exports and spy references for assertions.
 */
function loadRoutes({
  pdfUrl = "https://storage.googleapis.com/bucket/receipt.pdf",
  pdfThrows = false,
  wppThrows = false,
} = {}) {
  resetSourceModules();
  clearMockModules();

  const logs = [];
  setMockModule("@/lib/cloud-logger", {
    cloudLog: (entry) => logs.push(entry),
  });

  const wppCalls = [];
  setMockModule("@/lib/whatsapp", {
    sendWhatsAppMessage: async (phone, text, mediaUrl) => {
      wppCalls.push({ phone, text, mediaUrl });
      if (wppThrows) throw new Error("WhatsApp send failed");
    },
  });

  // Stub Prisma — routeFiscalOwnerOnly uses prisma.chatMessage.create.
  setMockModule("@/lib/prisma", {
    prisma: {
      chatMessage: {
        create: async () => ({}),
      },
    },
  });

  const pdfCalls = [];
  setMockModule("./trigger-fiscal-receipt.pdf", {
    buildAndAttachReceiptPdf: async (args) => {
      pdfCalls.push(args);
      if (pdfThrows) throw new Error("PDF build failed");
      return pdfUrl;
    },
  });

  const mod = require(
    "../../src/app/api/payment-intents/_lib/trigger-fiscal-receipt.routes.ts",
  );

  return { mod, logs, wppCalls, pdfCalls };
}

// ── A. routeFiscalFallback — tier-2 PDF path ──────────────────────────────────

test("routeFiscalFallback — logs FISCAL_RECEIPT_TIER2_COMPROBANTE with reason=arca_failed", async () => {
  const { mod, logs } = loadRoutes();
  await mod.routeFiscalFallback({ ...BASE_INPUT, agentText: "Sin respuesta del modelo." });

  const tier2Log = logs.find((l) => l.action === "FISCAL_RECEIPT_TIER2_COMPROBANTE");
  assert.ok(tier2Log, "must log FISCAL_RECEIPT_TIER2_COMPROBANTE");
  assert.equal(tier2Log.data.tier2Reason, "arca_failed");
  assert.equal(tier2Log.severity, "WARNING");
});

test("routeFiscalFallback — calls buildAndAttachReceiptPdf with sale context", async () => {
  const { mod, pdfCalls } = loadRoutes();
  await mod.routeFiscalFallback({ ...BASE_INPUT, agentText: "" });

  assert.equal(pdfCalls.length, 1, "PDF builder must be called exactly once");
  assert.equal(pdfCalls[0].paymentIntentId, BASE_INPUT.paymentIntentId);
  assert.equal(pdfCalls[0].businessId, BASE_INPUT.businessId);
  assert.equal(pdfCalls[0].saleId, BASE_INPUT.saleId);
  assert.equal(pdfCalls[0].monto, BASE_INPUT.monto);
  assert.equal(pdfCalls[0].customerName, BASE_INPUT.customerName);
});

test("routeFiscalFallback — sends WhatsApp with PDF mediaUrl attached", async () => {
  const { mod, wppCalls } = loadRoutes({ pdfUrl: "https://example.com/receipt.pdf" });
  await mod.routeFiscalFallback({ ...BASE_INPUT, agentText: "" });

  assert.equal(wppCalls.length, 1, "WhatsApp must be called once");
  assert.equal(wppCalls[0].mediaUrl, "https://example.com/receipt.pdf");
  assert.ok(
    wppCalls[0].text.includes(BASE_INPUT.customerName),
    "message must include customer name",
  );
});

test("routeFiscalFallback — returns { ok: false, reason: 'agent_fallback' }", async () => {
  const { mod } = loadRoutes();
  const result = await mod.routeFiscalFallback({ ...BASE_INPUT, agentText: "" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "agent_fallback");
});

test("routeFiscalFallback — PDF failure is non-fatal: still sends text-only WhatsApp", async () => {
  const { mod, wppCalls } = loadRoutes({ pdfThrows: true });
  const result = await mod.routeFiscalFallback({ ...BASE_INPUT, agentText: "" });

  // Must still send WhatsApp (text-only — no mediaUrl)
  assert.equal(wppCalls.length, 1, "WhatsApp must be called even when PDF fails");
  assert.equal(wppCalls[0].mediaUrl, undefined);
  // Must still return !ok
  assert.equal(result.ok, false);
});

test("routeFiscalFallback — WhatsApp failure is non-fatal: still returns !ok", async () => {
  const { mod } = loadRoutes({ wppThrows: true });
  // Must not throw — non-fatal
  const result = await mod.routeFiscalFallback({ ...BASE_INPUT, agentText: "" });
  assert.equal(result.ok, false);
});

test("routeFiscalFallback — works with saleId=null (standalone PaymentIntent)", async () => {
  const { mod, pdfCalls } = loadRoutes();
  await mod.routeFiscalFallback({ ...BASE_INPUT, saleId: null, agentText: "" });

  assert.equal(pdfCalls[0].saleId, null, "standalone PI must pass saleId=null to PDF builder");
});

// ── B. routeFiscalOwnerOnly — tier-2 PDF path ────────────────────────────────

test("routeFiscalOwnerOnly — logs FISCAL_RECEIPT_TIER2_COMPROBANTE with reason=missing_arca_credentials", async () => {
  const { mod, logs } = loadRoutes();
  await mod.routeFiscalOwnerOnly({
    ...BASE_INPUT,
    agentText: "Para emitir facturas electrónicas falta configurar lo siguiente.",
  });

  const tier2Log = logs.find((l) => l.action === "FISCAL_RECEIPT_TIER2_COMPROBANTE");
  assert.ok(tier2Log, "must log FISCAL_RECEIPT_TIER2_COMPROBANTE");
  assert.equal(tier2Log.data.tier2Reason, "missing_arca_credentials");
  assert.equal(tier2Log.severity, "INFO");
});

test("routeFiscalOwnerOnly — calls buildAndAttachReceiptPdf with sale context", async () => {
  const { mod, pdfCalls } = loadRoutes();
  await mod.routeFiscalOwnerOnly({
    ...BASE_INPUT,
    agentText: "Para emitir facturas electrónicas falta.",
  });

  assert.equal(pdfCalls.length, 1, "PDF builder must be called exactly once");
  assert.equal(pdfCalls[0].paymentIntentId, BASE_INPUT.paymentIntentId);
  assert.equal(pdfCalls[0].saleId, BASE_INPUT.saleId);
  assert.equal(pdfCalls[0].monto, BASE_INPUT.monto);
});

test("routeFiscalOwnerOnly — sends WhatsApp with PDF mediaUrl attached", async () => {
  const { mod, wppCalls } = loadRoutes({ pdfUrl: "https://example.com/tier2.pdf" });
  await mod.routeFiscalOwnerOnly({
    ...BASE_INPUT,
    agentText: "Para emitir facturas electrónicas falta.",
  });

  assert.equal(wppCalls.length, 1);
  assert.equal(wppCalls[0].mediaUrl, "https://example.com/tier2.pdf");
  assert.ok(wppCalls[0].text.includes(BASE_INPUT.customerName));
});

test("routeFiscalOwnerOnly — returns { ok: false, reason: 'setup_guidance' }", async () => {
  const { mod } = loadRoutes();
  const result = await mod.routeFiscalOwnerOnly({
    ...BASE_INPUT,
    agentText: "Para emitir facturas electrónicas falta.",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "setup_guidance");
});

test("routeFiscalOwnerOnly — PDF failure is non-fatal: still sends WhatsApp text-only", async () => {
  const { mod, wppCalls } = loadRoutes({ pdfThrows: true });
  const result = await mod.routeFiscalOwnerOnly({
    ...BASE_INPUT,
    agentText: "Para emitir facturas electrónicas falta.",
  });

  assert.equal(wppCalls.length, 1);
  assert.equal(wppCalls[0].mediaUrl, undefined, "no mediaUrl when PDF failed");
  assert.equal(result.ok, false);
});
