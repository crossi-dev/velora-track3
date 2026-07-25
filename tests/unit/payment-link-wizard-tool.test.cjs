// Unit tests — payment-link wizard MCP tools (Entrega 1).
//
// Covers:
//   T-4: approval-gate seam (isAutoApprovalEnabled) — always OFF in Entrega 1.
//
// Money path. Uses the phase4 module-hooks harness to stub heavy deps and load
// the TS sources directly.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// ── Shared mock factories ─────────────────────────────────────────────────────

function makeCloudLoggerMock() {
  return { cloudLog: () => {} };
}

// Loads the payment-link wizard handlers with all money-path deps stubbed.
// Captures the params handed to the provider adapter so tests can assert the
// expiresInDays threading (T-6 G/H) without a real MP call.
function loadHandlers({
  saleResult,
  collectionResult = { paymentIntentId: "pi-1", amountARS: 4500, checkoutUrl: "https://mp.test/checkout/abc", providerRef: "pref-1", status: "pending", currency: "ARS" },
  healResult = { healed: false },
  existingPI = { checkoutUrl: "https://mp.test/checkout/existing", monto: { toNumber: () => 4500 } },
} = {}) {
  resetSourceModules();
  clearMockModules();

  const capture = { adapterParams: null, approvalCalls: 0, useCaseInput: null, productFindManyWhere: null, customerFindFirstWhere: null };

  setMockModule("@/lib/cloud-logger", makeCloudLoggerMock());
  setMockModule("@/lib/prisma", {
    prisma: {
      paymentIntent: { findUnique: async () => existingPI },
      // Render tool resolves names + prices from the catalog (tenant-scoped).
      product: {
        findMany: async (args) => {
          capture.productFindManyWhere = args && args.where;
          return [
            { id: "prod-1", name: "Alfajor triple", price: 1500 },
            { id: "prod-2", name: "Agua 500ml", price: 1000 },
          ];
        },
      },
      // Render tool resolves customer name (tenant-scoped).
      customer: {
        findFirst: async (args) => {
          capture.customerFindFirstWhere = args && args.where;
          return { name: "Juan Pérez" };
        },
      },
      // V-4 guard: write tool fetches the business config.
      business: {
        findUnique: async () => ({
          postalCode: "5500",
          paymentProvider: "mercadopago",
          alias: null,
          whatsappPhone: "5490000000000",
          cuit: "20123456789",
        }),
      },
    },
  });
  setMockModule("@/app/api/payment-intents/_lib/register-sale-with-payment-link-use-case", {
    registerSaleWithPaymentLinkUseCase: async (input) => { capture.useCaseInput = input; return saleResult; },
  });
  setMockModule("@/app/api/agents/payments/jsonrpc/_lib/payment-provider", {
    getPaymentProvider: async () => ({
      createCollection: async (params) => { capture.adapterParams = params; return collectionResult; },
    }),
  });
  setMockModule("@/app/api/agents/payments/jsonrpc/_lib/payment-link-orphan-heal", {
    healOrphanedIntent: async () => healResult,
  });
  setMockModule("@/app/api/agents/payments/jsonrpc/_lib/mp-preference-sale-items", {
    resolveSaleItemsForPreference: async () => ({ items: [{ title: "Alfajor", quantity: 3, unit_price: 1500 }] }),
  });
  // sales-mutations pulls the full sale use-case chain — stub to just the constant.
  setMockModule("./sales-mutations", { MCP_ACTOR_USER_ID: "mcp-system" });
  // approval-gate: count calls + force gate ON (Entrega 1).
  setMockModule("./approval-gate", { isAutoApprovalEnabled: async () => { capture.approvalCalls += 1; return false; } });
  // V-4 guard: getMissingBusinessData — pass through the real pure function since it
  // has no side-effects. Stub only to avoid module resolution issues in the test harness.
  setMockModule("@velora/core-utils/missing-business-data", {
    getMissingBusinessData: ({ paymentProvider, alias }) => {
      // Mirror the real logic: alias_cbu + no alias → blocked.
      const isAliasCbu = paymentProvider === "alias_cbu";
      const blocked = isAliasCbu && (alias == null || alias.trim() === "");
      return {
        paymentLinks: {
          blocked,
          ownerPrompt: blocked ? "Para generar links de pago por alias necesito tu alias o CBU." : "",
        },
      };
    },
  });

  const mod = require("../../src/lib/mcp/_lib/payment-link-mutations.ts");
  return { mod, capture };
}

const VALID_WRITE_ARGS = {
  customerId: "cust-1",
  items: [{ productId: "prod-1", quantity: 3 }],
  description: "3 alfajores",
  idempotencyKey: "widget-uuid-1",
};

const CREATED = { outcome: "created", paymentIntentId: "pi-1", saleId: "sale-1", grandTotal: 4500 };

// ── T-4: approval-gate seam ───────────────────────────────────────────────────

test("approval-gate: isAutoApprovalEnabled returns false (gate always ON in Entrega 1)", async () => {
  resetSourceModules();
  clearMockModules();
  const { isAutoApprovalEnabled } = require("../../src/lib/mcp/_lib/approval-gate.ts");
  assert.equal(await isAutoApprovalEnabled("any-business-id"), false);
});

// ── T-5: open_payment_link_wizard (RENDER — side-effect-free) ──────────────────

test("Test E: render tool enriches prefill with catalog name + price + computed total + customerName", async () => {
  const { mod, capture } = loadHandlers({ saleResult: CREATED });
  const res = await mod.handleOpenPaymentLinkWizard("biz-1", {
    description: "3 alfajores + 2 aguas", customerId: "cust-1",
    items: [{ productId: "prod-1", quantity: 3 }, { productId: "prod-2", quantity: 2 }],
  });
  assert.ok(!res.isError, "valid render must not be an error");
  const pf = res.structuredContent.prefill;
  assert.equal(pf.customerId, "cust-1");
  assert.equal(pf.customerName, "Juan Pérez", "customer name must be resolved from DB");
  assert.equal(pf.items.length, 2);
  // Catalog enrichment: name + unit price resolved from the (mocked) catalog.
  assert.equal(pf.items[0].name, "Alfajor triple");
  assert.equal(pf.items[0].unitPrice, 1500);
  // Total derived from catalog prices (NABAOS): 3*1500 + 2*1000 = 6500.
  assert.equal(pf.totalARS, 6500);
  // Tenant isolation regression guard: both queries must scope to the businessId.
  assert.equal(capture.productFindManyWhere && capture.productFindManyWhere.businessId, "biz-1", "product.findMany must scope to businessId");
  assert.equal(capture.customerFindFirstWhere && capture.customerFindFirstWhere.businessId, "biz-1", "customer.findFirst must scope to businessId");
});

test("Test E1b: render tool uses unitPriceOverride when present", async () => {
  const { mod } = loadHandlers({ saleResult: CREATED });
  const res = await mod.handleOpenPaymentLinkWizard("biz-1", {
    description: "precio negociado", customerId: "cust-1",
    items: [{ productId: "prod-1", quantity: 2, unitPriceOverride: 1200 }],
  });
  const pf = res.structuredContent.prefill;
  assert.equal(pf.items[0].unitPrice, 1200, "override wins over catalog price");
  assert.equal(pf.totalARS, 2400);
});

test("Test E2: render tool without customerId → real item names/prices resolved, empty customer prefill (no error)", async () => {
  // Bug fix: no-customer path (catalog-selector "Cobrar a cliente") must still
  // resolve real item names + prices from the catalog instead of falling back to
  // productId-as-name and 0-as-price placeholders.
  const { mod, capture } = loadHandlers({ saleResult: CREATED });
  const res = await mod.handleOpenPaymentLinkWizard("biz-1", {
    description: "x", customerId: "", items: [{ productId: "prod-1", quantity: 2 }],
  });
  assert.ok(!res.isError, "no-customer path must not error — wizard opens with customer picker");
  const pf = res.structuredContent.prefill;
  // Customer fields must be empty — the owner picks in-widget.
  assert.equal(pf.customerId, "", "customerId must be empty string");
  assert.equal(pf.customerName, "", "customerName must be empty string");
  // Item fields must be resolved from the catalog (not placeholder id/0).
  assert.equal(pf.items[0].name, "Alfajor triple", "item name must be resolved from catalog");
  assert.equal(pf.items[0].unitPrice, 1500, "unitPrice must be resolved from catalog, not 0");
  assert.equal(pf.totalARS, 3000, "totalARS must be computed from real catalog prices");
  // Tenant isolation: product lookup must still be scoped.
  assert.equal(capture.productFindManyWhere && capture.productFindManyWhere.businessId, "biz-1");
});

test("Test E3: render tool with empty items → validation error", async () => {
  const { mod } = loadHandlers({ saleResult: CREATED });
  const res = await mod.handleOpenPaymentLinkWizard("biz-1", {
    description: "x", customerId: "cust-1", items: [],
  });
  assert.ok(res.isError, "empty items must error");
});

test("Test E4: render tool with unknown productId → product_not_found error", async () => {
  // prod-99 is not in the mocked catalog (only prod-1 and prod-2 exist).
  const { mod } = loadHandlers({ saleResult: CREATED });
  const res = await mod.handleOpenPaymentLinkWizard("biz-1", {
    description: "x", customerId: "cust-1",
    items: [{ productId: "prod-99", quantity: 1 }],
  });
  assert.ok(res.isError, "unknown productId must error");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.error, "product_not_found", "error code must be product_not_found");
  assert.ok(body.message.includes("prod-99"), "message must name the missing productId");
});

// ── T-6: create_tracked_payment_link (WRITE — gated money path) ────────────────

test("Test F: happy path → use-case + adapter called, returns paymentLinkUrl", async () => {
  const { mod, capture } = loadHandlers({ saleResult: CREATED });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  assert.ok(!res.isError, "happy path must not error");
  assert.equal(res.structuredContent.paymentLinkUrl, "https://mp.test/checkout/abc");
  assert.equal(res.structuredContent.paymentIntentId, "pi-1");
  // NABAOS: charge amount comes from the use-case grandTotal, not a model number.
  assert.equal(res.structuredContent.amountARS, 4500);
  assert.equal(capture.useCaseInput.actorUserId, "mcp-system");
  // GATE-3 safe-by-default: content text carries NO URL.
  assert.ok(!res.content[0].text.includes("mp.test"), "content must not leak the URL");
});

test("Test G: omitting expiresInDays → adapter receives expiresInDays=3", async () => {
  const { mod, capture } = loadHandlers({ saleResult: CREATED });
  await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  assert.equal(capture.adapterParams.expiresInDays, 3);
  // C-1: use-case must NOT receive expiresInDays.
  assert.equal(capture.useCaseInput.expiresInDays, undefined);
});

test("Test H: expiresInDays=7 → adapter receives 7", async () => {
  const { mod, capture } = loadHandlers({ saleResult: CREATED });
  await mod.handleCreateTrackedPaymentLink("biz-1", { ...VALID_WRITE_ARGS, expiresInDays: 7 });
  assert.equal(capture.adapterParams.expiresInDays, 7);
});

test("Test I: payment_provider_not_connected → mp_not_connected distinct message", async () => {
  const { mod } = loadHandlers({ saleResult: CREATED, collectionResult: { error: "payment_provider_not_connected" } });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  assert.ok(res.isError);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.error, "mp_not_connected");
  assert.match(body.message, /no está conectado/);
});

test("Test I2: payment_provider_token_expired → token_expired distinct message", async () => {
  const { mod } = loadHandlers({ saleResult: CREATED, collectionResult: { error: "payment_provider_token_expired" } });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.error, "token_expired");
  assert.match(body.message, /expiró/);
});

test("Test I3: payment_token_decrypt_error → decrypt_error distinct message", async () => {
  const { mod } = loadHandlers({ saleResult: CREATED, collectionResult: { error: "payment_token_decrypt_error" } });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.error, "decrypt_error");
  assert.match(body.message, /credenciales/);
});

test("Test J: isAutoApprovalEnabled consulted once per invocation", async () => {
  const { mod, capture } = loadHandlers({ saleResult: CREATED });
  await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  assert.equal(capture.approvalCalls, 1);
});

test("Test K: replayed + orphan-heal heals → returns healed checkoutUrl", async () => {
  const { mod, capture } = loadHandlers({
    saleResult: { outcome: "replayed", paymentIntentId: "pi-1", saleId: "sale-1" },
    healResult: { healed: true, collection: { paymentIntentId: "pi-1", amountARS: 4500, checkoutUrl: "https://mp.test/checkout/healed", status: "pending", currency: "ARS" } },
  });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  assert.ok(!res.isError);
  assert.equal(res.structuredContent.paymentLinkUrl, "https://mp.test/checkout/healed");
  // created-path adapter must NOT have been called on the replayed branch.
  assert.equal(capture.adapterParams, null);
});

test("Test L: customerId missing → validation error", async () => {
  const { mod } = loadHandlers({ saleResult: CREATED });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", { ...VALID_WRITE_ARGS, customerId: "" });
  assert.ok(res.isError);
  assert.equal(JSON.parse(res.content[0].text).error, "validation");
});

test("Test M: empty items → validation error", async () => {
  const { mod } = loadHandlers({ saleResult: CREATED });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", { ...VALID_WRITE_ARGS, items: [] });
  assert.ok(res.isError);
  assert.equal(JSON.parse(res.content[0].text).error, "validation");
});

test("Test N: missing idempotencyKey → validation error (widget-generated, never model-supplied)", async () => {
  const { mod } = loadHandlers({ saleResult: CREATED });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", { ...VALID_WRITE_ARGS, idempotencyKey: "" });
  assert.ok(res.isError);
  assert.equal(JSON.parse(res.content[0].text).error, "validation");
});

test("Test O: use-case customer_not_found → mapped error surfaced", async () => {
  const { mod } = loadHandlers({ saleResult: { outcome: "customer_not_found" } });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  assert.ok(res.isError);
  assert.equal(JSON.parse(res.content[0].text).error, "customer_not_found");
});

test("Test P: use-case idempotency_conflict → isError with code intent_idempotency_conflict", async () => {
  const { mod } = loadHandlers({ saleResult: { outcome: "idempotency_conflict" } });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  assert.ok(res.isError, "idempotency_conflict must surface as error");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.error, "intent_idempotency_conflict");
});

// ── FIX 3: heal error codes must not be masked as generic mp_api_error ──────────
// Rationale: intent_not_found = DB corruption; invalid_amount = data error.
// Both must surface their real code so support can distinguish from MP API issues.

test("Test Q: heal error intent_not_found → surfaced as intent_not_found, not mp_api_error", async () => {
  const { mod } = loadHandlers({
    saleResult: { outcome: "replayed", paymentIntentId: "pi-1", saleId: "sale-1" },
    healResult: { error: "intent_not_found" },
  });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  assert.ok(res.isError, "heal intent_not_found must surface as error");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.error, "intent_not_found", "must preserve real error code, not downgrade to mp_api_error");
  assert.match(body.message, /soporte/, "message must direct to support");
});

test("Test R: heal error invalid_amount → surfaced as invalid_amount, not mp_api_error", async () => {
  const { mod } = loadHandlers({
    saleResult: { outcome: "replayed", paymentIntentId: "pi-1", saleId: "sale-1" },
    healResult: { error: "invalid_amount" },
  });
  const res = await mod.handleCreateTrackedPaymentLink("biz-1", VALID_WRITE_ARGS);
  assert.ok(res.isError, "heal invalid_amount must surface as error");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.error, "invalid_amount", "must preserve real error code, not downgrade to mp_api_error");
});
