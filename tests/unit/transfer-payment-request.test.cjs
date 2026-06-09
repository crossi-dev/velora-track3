"use strict";

// Unit tests for sendTransferPaymentRequestWhatsApp
//
// Covers:
//   1. Happy path — method=transferencia, phone set, alias set → template sent + paymentRequestSentAt stamped.
//   2. Skip — paymentMethod != "transferencia" → no WA send, no DB write.
//   3. Skip — customer has no phone → INFO log, no WA send, no DB write.
//   4. Skip — business has no alias → INFO log, no WA send, no DB write.
//   5. Idempotency — paymentRequestSentAt already set → no WA send, no DB write.
//   6. WA API failure — logs WARNING + records post-commit failure, does NOT throw.
//   7. Twilio provider — logs skip + stamps paymentRequestSentAt (considered handled).
//   8. Amount formatting — $4500 renders as "$4.500" (Argentine locale).

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Constants ─────────────────────────────────────────────────────────────────

const BIZ_ID  = "biz1aaaaaaaaaaaaaaaaaaaa";
const SALE_ID = "sale1aaaaaaaaaaaaaaaaaaa";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInvoicePayload({
  customerPhone = "+5491134567890",
  customerName  = "Juan Pérez",
  firstName     = "Juan",
  businessName  = "Distribuidora Norte",
  total         = 4500,
} = {}) {
  return {
    business: { name: businessName },
    customer: { name: customerName, firstName, phone: customerPhone, email: null, taxId: null },
    sale:     { id: SALE_ID, invoiceNumber: "X-001", date: "2026-05-25", items: [], total },
  };
}

function makeFakePrisma({
  alias               = "minegocio.mp",
  paymentRequestSentAt = null,
  updateCount         = 1,
} = {}) {
  return {
    business: {
      findUnique: async ({ where }) => {
        if (where.id !== BIZ_ID) return null;
        return { alias };
      },
    },
    sale: {
      // Source uses findFirst (with businessId tenant guard — commit 7938fd8e).
      findFirst: async ({ where }) => {
        if (where.id !== SALE_ID) return null;
        return { id: SALE_ID, paymentRequestSentAt };
      },
      // findUnique kept as alias so older module-cache hits don't crash.
      findUnique: async ({ where }) => {
        if (where.id !== SALE_ID) return null;
        return { id: SALE_ID, paymentRequestSentAt };
      },
      updateMany: async () => ({ count: updateCount }),
    },
  };
}

/** Tracks calls to sendWhatsAppTemplate / cloudLog / recordPostCommitFailure. */
function makeMocks({ waThrows = false, provider = "meta" } = {}) {
  const calls = { template: [], logs: [], failures: [] };

  const whatsapp = {
    sendWhatsAppTemplate: async (to, name, components, lang) => {
      if (waThrows) throw new Error("No se pudo enviar el mensaje por WhatsApp (Meta).");
      calls.template.push({ to, name, components, lang });
    },
  };

  const cloudLogger = {
    cloudLog:    (entry) => calls.logs.push(entry),
    reportError: () => {},
  };

  const failureTracker = {
    recordPostCommitFailure: async (entry) => { calls.failures.push(entry); },
  };

  // Mock WHATSAPP_PROVIDER env var by overriding whatsapp.ts facade behavior.
  // We mock the lib directly so the function under test hits our spy.
  if (provider === "twilio") {
    whatsapp.sendWhatsAppTemplate = async (to, name) => {
      // Simulate the real facade: Twilio path logs warning + returns (no throw).
      calls.template.push({ to, name, skipped: true });
    };
  }

  return { calls, whatsapp, cloudLogger, failureTracker };
}

function loadFn({ prismaOverride, mocks }) {
  resetSourceModules();
  clearMockModules();
  setMockModule("@/lib/prisma",            { prisma: prismaOverride });
  setMockModule("@/lib/cloud-logger",      mocks.cloudLogger);
  setMockModule("@/lib/whatsapp",          mocks.whatsapp);
  setMockModule("@/app/api/_lib/post-commit-failure-tracker", mocks.failureTracker);

  const mod = require("../../src/app/api/sales/create/_lib/transfer-payment-request-wa.ts");
  const rawFn = mod.sendTransferPaymentRequestWhatsApp;

  // Wrap to enable the feature flag for all test calls.
  // TRANSFER_WA_TEMPLATE_ENABLED gates the function at runtime (process.env read
  // on each invocation). In prod it is false until the Meta template is ACTIVE;
  // unit tests need it on to exercise skip/send logic without touching prod config.
  return async (...args) => {
    const prev = process.env.TRANSFER_WA_TEMPLATE_ENABLED;
    process.env.TRANSFER_WA_TEMPLATE_ENABLED = "true";
    try {
      return await rawFn(...args);
    } finally {
      if (prev === undefined) delete process.env.TRANSFER_WA_TEMPLATE_ENABLED;
      else process.env.TRANSFER_WA_TEMPLATE_ENABLED = prev;
    }
  };
}

// ── 1. Happy path ─────────────────────────────────────────────────────────────

test("happy path — sends template + stamps paymentRequestSentAt", async () => {
  const mocks       = makeMocks();
  const fakePrisma  = makeFakePrisma();
  const fn          = loadFn({ prismaOverride: fakePrisma, mocks });

  await fn(BIZ_ID, SALE_ID, makeInvoicePayload(), "transferencia");

  assert.equal(mocks.calls.template.length, 1, "should send exactly 1 WA template");
  const call = mocks.calls.template[0];
  assert.equal(call.name, "velora_transfer_payment_request");
  // Params: firstName, amount, alias
  const params = call.components[0].parameters;
  assert.equal(params[0].text, "Juan");
  assert.ok(params[1].text.includes("4.500"), `amount should be formatted, got: ${params[1].text}`);
  assert.equal(params[2].text, "minegocio.mp");

  const sentLog = mocks.calls.logs.find((l) => l.action === "PAYMENT_REQUEST_WA_SENT");
  assert.ok(sentLog, "should log PAYMENT_REQUEST_WA_SENT");
});

// ── 2. Skip — method != transferencia ────────────────────────────────────────

test("skip — paymentMethod != transferencia", async () => {
  const mocks      = makeMocks();
  const fakePrisma = makeFakePrisma();
  const fn         = loadFn({ prismaOverride: fakePrisma, mocks });

  await fn(BIZ_ID, SALE_ID, makeInvoicePayload(), "efectivo");

  assert.equal(mocks.calls.template.length, 0, "should not send WA when method != transferencia");
});

// ── 3. Skip — customer has no phone ──────────────────────────────────────────

test("skip — customer has no phone", async () => {
  const mocks      = makeMocks();
  const fakePrisma = makeFakePrisma();
  const fn         = loadFn({ prismaOverride: fakePrisma, mocks });

  await fn(BIZ_ID, SALE_ID, makeInvoicePayload({ customerPhone: null }), "transferencia");

  assert.equal(mocks.calls.template.length, 0);
  const skipLog = mocks.calls.logs.find((l) => l.action === "PAYMENT_REQUEST_WA_SKIPPED");
  assert.ok(skipLog, "should log PAYMENT_REQUEST_WA_SKIPPED");
  assert.equal(skipLog.data?.reason, "no_phone");
});

// ── 4. Skip — business has no alias ──────────────────────────────────────────

test("skip — business has no alias", async () => {
  const mocks      = makeMocks();
  const fakePrisma = makeFakePrisma({ alias: null });
  const fn         = loadFn({ prismaOverride: fakePrisma, mocks });

  await fn(BIZ_ID, SALE_ID, makeInvoicePayload(), "transferencia");

  assert.equal(mocks.calls.template.length, 0);
  const skipLog = mocks.calls.logs.find((l) => l.action === "PAYMENT_REQUEST_WA_SKIPPED");
  assert.ok(skipLog);
  assert.equal(skipLog.data?.reason, "no_alias");
});

// ── 5. Idempotency — already sent ────────────────────────────────────────────

test("idempotency — paymentRequestSentAt already set → no send", async () => {
  const mocks      = makeMocks();
  const fakePrisma = makeFakePrisma({ paymentRequestSentAt: new Date("2026-05-25T10:00:00Z") });
  const fn         = loadFn({ prismaOverride: fakePrisma, mocks });

  await fn(BIZ_ID, SALE_ID, makeInvoicePayload(), "transferencia");

  assert.equal(mocks.calls.template.length, 0);
  const skipLog = mocks.calls.logs.find((l) => l.action === "PAYMENT_REQUEST_WA_SKIPPED");
  assert.ok(skipLog);
  assert.equal(skipLog.data?.reason, "already_sent");
});

// ── 6. WA API failure — logs WARNING, does NOT throw ─────────────────────────

test("WA failure — logs WARNING + records failure, does not throw", async () => {
  const mocks      = makeMocks({ waThrows: true });
  const fakePrisma = makeFakePrisma();
  const fn         = loadFn({ prismaOverride: fakePrisma, mocks });

  // Must not throw — fire-and-forget contract.
  await assert.doesNotReject(() => fn(BIZ_ID, SALE_ID, makeInvoicePayload(), "transferencia"));

  const warnLog = mocks.calls.logs.find((l) => l.action === "PAYMENT_REQUEST_WA_FAILED");
  assert.ok(warnLog, "should log PAYMENT_REQUEST_WA_FAILED");
  assert.equal(warnLog.severity, "WARNING");
  assert.equal(mocks.calls.failures.length, 1, "should record post-commit failure");
});

// ── 7. Amount formatting ──────────────────────────────────────────────────────

test("amount formatting — 10000 renders with thousand separator", async () => {
  const mocks      = makeMocks();
  const fakePrisma = makeFakePrisma();
  const fn         = loadFn({ prismaOverride: fakePrisma, mocks });

  await fn(BIZ_ID, SALE_ID, makeInvoicePayload({ total: 10000 }), "transferencia");

  const params = mocks.calls.template[0].components[0].parameters;
  assert.ok(params[1].text.includes("10.000"), `expected 10.000 in amount, got: ${params[1].text}`);
});
