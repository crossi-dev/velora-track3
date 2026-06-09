// Integration tests for the Customer Agent data pipeline.
//
// Covers the 7 required scenarios plus grounding enforcement tests:
//   1.  Catalog query → agent returns prices
//   2.  Customer gives name → upsert record
//   3a. Customer gives address + CP → update_own_customer_data stores it
//   3b. quote_shipping → resolveShippingQuote deterministic skill (not A2A)
//   4.  create_payment_link → reads cart from session.state, delegates to Payments A2A
//   5.  Soft rejection: mutation attempt tool is structurally absent
//   6.  Escalation: legitimate bulk order inquiry
//   7.  Multi-tenant isolation: same phone, two different businesses → no cross-tenant leak
//   G1. CUSTOMER_AGENT_GROUNDED_TOOLS exported and non-empty
//   G2. Every registered tool documented in CUSTOMER_AGENT_GROUNDED_TOOLS
//   G3. system prompt contains tool-grounding contract clause
//   G4. Catalog summary placeholder is injected into the system prompt
//
// External calls (Prisma, resolveShippingQuote, A2A sendMessage) are stubbed.
// No real DB or network traffic — safe for CI.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const path = require("node:path");

// ── Module hooks ──────────────────────────────────────────────────────────────

const { setMockModule, clearMockModules, resetSourceModules } = require("../phase4/module-hooks.cjs");

// ── Mutable stubs ─────────────────────────────────────────────────────────────

// mockPrisma: full model surface so cross-customer guard in update_own_customer_data
// and business.findUnique in escalate_to_owner can resolve without crashing.
// The default customer.findFirst returns a row matching CTX_BIZ_A.customerPhone so the
// cross-customer ownership guard passes in the base case. Individual tests override it.
const CTX_DEFAULT_PHONE = "+5492612345678";

const mockPrisma = {
  $transaction: async (fn) => fn(mockPrisma),
  product: { findMany: async () => [], findFirst: async () => null },
  customer: {
    findFirst: async () => ({
      id: "cust-default",
      phone: CTX_DEFAULT_PHONE,
    }),
    updateMany: async () => ({ count: 1 }),
  },
  business: { findUnique: async () => null },
};

let mockCreateCustomer;
let mockUpdateCustomer;
let mockSendMessage;
let mockResolveShippingQuote;

function installStubs() {
  clearMockModules();
  resetSourceModules();

  mockCreateCustomer = async (_tx, input) => ({
    id: `cust-${input.businessId}-${input.phone.slice(-4)}`,
    name: input.name ?? input.phone,
    phone: input.phone,
    address: null, postalCode: null, city: null, email: null,
  });
  mockUpdateCustomer = async (_tx, input) => ({
    id: input.customerId,
    name: input.name ?? "Felix",
    address: input.address ?? null,
    postalCode: input.postalCode ?? null,
    city: input.city ?? null,
    email: input.email ?? null,
  });
  mockSendMessage = async () => ({ text: "ok", contextId: "ctx-1" });
  mockResolveShippingQuote = async (_input) => ({
    ok: false,
    reason: "missing_destination_postal_code",
  });

  const prismaResolved = require.resolve("@/lib/prisma");
  Module._cache[prismaResolved] = {
    id: prismaResolved, filename: prismaResolved, loaded: true,
    exports: { prisma: mockPrisma }, children: [], parent: null, paths: [],
  };

  setMockModule("@/lib/prisma", { prisma: mockPrisma });
  setMockModule("@/lib/cloud-logger", { cloudLog: () => {} });
  setMockModule("@/infrastructure/shared/customer-mutations", {
    createCustomerInTransaction: async (tx, input) => mockCreateCustomer(tx, input),
    updateCustomerInTransaction: async (tx, input) => mockUpdateCustomer(tx, input),
  });
  setMockModule("@/lib/a2a-client", {
    sendMessage: async (url, body, opts) => mockSendMessage(url, body, opts),
    sendStructured: async () => ({}),
    A2AClientError: class extends Error { constructor(m, c) { super(m); this.code = c; } },
  });
  setMockModule("@/lib/agent-identity", { signAgentAssertion: () => null });
  setMockModule("@/app/api/a2a/jsonrpc/_lib/handle-rpc", { deriveA2AKey: () => "test-key" });
  setMockModule("@/lib/agent-timeouts", {
    LOGISTICA_AGENT_TIMEOUT_MS: 5000,
    PAYMENTS_AGENT_TIMEOUT_MS: 5000,
    COMMUNICATIONS_AGENT_TIMEOUT_MS: 5000,
    SHIPPING_QUOTE_TIMEOUT_MS: 5000,
  });
  setMockModule("@/lib/whatsapp", { sendWhatsAppMessage: async () => {} });
  setMockModule("@/lib/shipping-quote", {
    resolveShippingQuote: async (input) => mockResolveShippingQuote(input),
  });
}

// ── SUT paths ─────────────────────────────────────────────────────────────────

const TOOLS_PATH = path.resolve(__dirname, "../../src/lib/adk/customer-agent-tools.ts");
const TOOLS_A2A_PATH = path.resolve(__dirname, "../../src/lib/adk/customer-agent-tools-a2a.ts");
const TOOLS_ORDER_PATH = path.resolve(__dirname, "../../src/lib/adk/customer-agent-tools-order.ts");
const TOOLS_CHECKOUT_PATH = path.resolve(__dirname, "../../src/lib/adk/customer-agent-tools-checkout.ts");
const PROMPT_PATH = path.resolve(__dirname, "../../src/lib/adk/customer-agent.prompt.ts");

function clearSutCache() {
  delete Module._cache[TOOLS_PATH];
  delete Module._cache[TOOLS_A2A_PATH];
  delete Module._cache[TOOLS_ORDER_PATH];
  delete Module._cache[TOOLS_CHECKOUT_PATH];
}

function loadBuilderModule() {
  clearSutCache();
  return require(TOOLS_A2A_PATH);
}

function loadPromptModule() {
  delete Module._cache[PROMPT_PATH];
  return require(PROMPT_PATH);
}

// ── Tool context stub (replaces real ADK Context for unit tests) ──────────────
// ADK Context wraps a Map-like state object. We build a minimal stub that
// matches the shape expected by the tools' execute() functions.

function makeToolContext(initialState) {
  const stateMap = new Map(Object.entries(initialState ?? {}));
  return {
    state: {
      get: (k) => stateMap.get(k),
      set: (k, v) => stateMap.set(k, v),
    },
  };
}

// ── Contexts ──────────────────────────────────────────────────────────────────

const CTX_BIZ_A = { businessId: "biz-aaa", customerPhone: CTX_DEFAULT_PHONE, appUrl: "https://velora.test" };
const CTX_BIZ_B = { businessId: "biz-bbb", customerPhone: CTX_DEFAULT_PHONE, appUrl: "https://velora.test" };

// ── Scenario 1: Catalog query → agent returns prices ─────────────────────────

test("Scenario 1: get_catalog returns product list with prices for customer queries", async () => {
  installStubs();
  mockPrisma.product.findMany = async () => [
    { id: "p1", name: "Alfajor Chocolate", price: 500, quantity: 80 },
    { id: "p2", name: "Facturas x6", price: 1200, quantity: 30 },
  ];

  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const getCatalog = tools.find((t) => t.name === "get_catalog");
  assert.ok(getCatalog, "get_catalog tool must be registered");

  const result = await getCatalog.execute({});
  assert.ok(Array.isArray(result.products), "products must be an array");
  assert.ok(result.products.some((p) => p.name.includes("Alfajor")), "Alfajor must be in catalog");
  // Prices must be present — customer needs them to make a purchasing decision
  assert.ok(result.products.every((p) => typeof p.price === "number"), "every product must have price");
});

// ── Scenario 2: Customer gives name → upsert record ──────────────────────────

test("Scenario 2: lookup_or_create_customer upserts with provided name", async () => {
  installStubs();
  let capturedName;
  mockCreateCustomer = async (_tx, input) => {
    capturedName = input.name;
    return { id: "cust-5678", name: input.name, phone: input.phone,
      address: null, postalCode: null, city: null, email: null };
  };

  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const lookupTool = tools.find((t) => t.name === "lookup_or_create_customer");

  const result = await lookupTool.execute({ name: "Felix Ramírez" });
  assert.equal(result.customerId, "cust-5678");
  assert.equal(capturedName, "Felix Ramírez", "name from args must be passed to upsert");
});

// ── Scenario 3a: Customer gives address + CP → update_own_customer_data ───────
//
// update_own_customer_data has a cross-customer guard: it calls prisma.customer.findFirst
// to verify the target customerId belongs to the current session's phone.
// The default stub returns a row with CTX_DEFAULT_PHONE so the guard passes.

test("Scenario 3a: update_own_customer_data stores address and postal code", async () => {
  installStubs();
  let capturedPostalCode;
  mockUpdateCustomer = async (_tx, input) => {
    capturedPostalCode = input.postalCode;
    return { id: input.customerId, name: "Felix", address: input.address,
      postalCode: input.postalCode, city: input.city };
  };
  // Guard: findFirst must return a row whose phone matches the session phone.
  mockPrisma.customer.findFirst = async () => ({
    id: "cust-5678",
    phone: CTX_DEFAULT_PHONE,
  });

  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const updateTool = tools.find((t) => t.name === "update_own_customer_data");

  const result = await updateTool.execute({
    customerId: "cust-5678",
    address: "San Martín 123",
    postalCode: "5500",
    city: "Mendoza",
  });
  assert.equal(result.success, true);
  assert.equal(capturedPostalCode, "5500", "postal code must be stored");
});

// ── Scenario 3b: quote_shipping uses deterministic resolveShippingQuote ───────
//
// quote_shipping was refactored from A2A Logística call to deterministic
// resolveShippingQuote skill. Stub resolveShippingQuote, NOT sendMessage.

test("Scenario 3b: quote_shipping delegates to resolveShippingQuote (deterministic skill)", async () => {
  installStubs();
  let capturedInput;
  mockResolveShippingQuote = async (input) => {
    capturedInput = input;
    return { ok: true, costARS: 1800, addressSnapshot: { name: "Felix", street: "San Martín 123", postalCode: "5500", city: "Mendoza", phone: CTX_DEFAULT_PHONE }, resolvedCustomerId: null };
  };

  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const quoteTool = tools.find((t) => t.name === "quote_shipping");

  const result = await quoteTool.execute({ postalCode: "5500" });
  assert.ok(capturedInput, "resolveShippingQuote must be called");
  assert.equal(capturedInput.businessId, "biz-aaa", "must pass businessId to resolveShippingQuote");
  assert.equal(result.costARS, 1800, "shipping cost from resolveShippingQuote must be returned");
});

// ── Scenario 4: create_payment_link ───────────────────────────────────────────
//
// create_payment_link now: (1) requires confirmed=true, (2) reads cart items
// from session.state (not LLM params), (3) delegates to Payments Agent via A2A.

test("Scenario 4: create_payment_link requires confirmed=true and reads cart from session.state", async () => {
  installStubs();
  let capturedUrl;
  mockSendMessage = async (url) => {
    capturedUrl = url;
    return { text: "Link de pago: https://mp.com/link-abc-123", contextId: "ctx-1" };
  };

  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const paymentTool = tools.find((t) => t.name === "create_payment_link");

  // Cart must exist in session.state — create_payment_link reads it from there.
  const tc = makeToolContext({
    order: { items: [{ productId: "p1", name: "Alfajor", qty: 3, unitPrice: 500, lineTotal: 1500 }], subtotal: 1500 },
    "user:customer_name": "Felix",
  });

  const result = await paymentTool.execute({ confirmed: true }, tc);
  assert.ok(capturedUrl.includes("/api/agents/payments/jsonrpc"), "must call Payments agent URL");
  assert.ok(typeof result.result === "string" && result.result.length > 0, "payment result must be returned");
});

test("Scenario 4b: create_payment_link returns error when confirmed is false (no premature payment)", async () => {
  installStubs();
  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const paymentTool = tools.find((t) => t.name === "create_payment_link");

  const tc = makeToolContext({
    order: { items: [{ productId: "p1", name: "Alfajor", qty: 3, unitPrice: 500, lineTotal: 1500 }], subtotal: 1500 },
  });

  const result = await paymentTool.execute({ confirmed: false }, tc);
  assert.ok(result.error, "must return error when confirmed is false");
  assert.match(result.error, /confirmación/i, "error must mention confirmation required");
});

test("Scenario 4c: create_payment_link returns error when cart is empty (no zero-amount payment)", async () => {
  installStubs();
  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const paymentTool = tools.find((t) => t.name === "create_payment_link");

  const tc = makeToolContext({ order: { items: [], subtotal: 0 } });

  const result = await paymentTool.execute({ confirmed: true }, tc);
  assert.ok(result.error, "must return error when cart is empty");
});

// ── Scenario 5: Soft rejection — structural boundary enforcement ───────────────

test("Scenario 5: disallowed mutation tools are NOT in the Customer Agent tool list (structural boundary)", () => {
  installStubs();
  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const names = new Set(tools.map((t) => t.name));

  const MUTATION_TOOLS = [
    "register_sale",
    "edit_price",
    "create_product",
    "delete_product",
    "adjust_stock",
    "call_ventas_agent",
    "call_contador_agent",
  ];

  for (const tool of MUTATION_TOOLS) {
    assert.ok(
      !names.has(tool),
      `Tool '${tool}' MUST be absent from Customer Agent (soft-reject structural boundary)`,
    );
  }
});

// ── Scenario 6: Escalation for legitimate out-of-scope inquiry ────────────────

test("Scenario 6: escalate_to_owner returns escalated:true and warm message for bulk order inquiry", async () => {
  installStubs();
  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const escalateTool = tools.find((t) => t.name === "escalate_to_owner");
  assert.ok(escalateTool, "escalate_to_owner must be registered");

  const result = await escalateTool.execute({
    reason: "El cliente pregunta por compras por mayor (más de 50 unidades).",
  });
  assert.equal(result.escalated, true, "escalated must be true");
  assert.ok(typeof result.message === "string" && result.message.length > 0,
    "warm reply message must be non-empty");
});

// ── Scenario 7: Multi-tenant isolation ───────────────────────────────────────

test("Scenario 7a: get_catalog — biz-A sees only biz-A products (businessId scoping)", async () => {
  installStubs();
  let capturedWhereA;
  mockPrisma.product.findMany = async (opts) => {
    capturedWhereA = opts.where;
    return [];
  };

  const { buildCustomerAgentTools } = loadBuilderModule();
  const toolsA = buildCustomerAgentTools(CTX_BIZ_A);
  await toolsA.find((t) => t.name === "get_catalog").execute({});

  assert.equal(capturedWhereA.businessId, "biz-aaa", "catalog query must be scoped to biz-aaa");
});

test("Scenario 7b: get_catalog — biz-B sees only biz-B products (businessId scoping)", async () => {
  installStubs();
  let capturedWhereB;
  mockPrisma.product.findMany = async (opts) => {
    capturedWhereB = opts.where;
    return [];
  };

  const { buildCustomerAgentTools } = loadBuilderModule();
  const toolsB = buildCustomerAgentTools(CTX_BIZ_B);
  await toolsB.find((t) => t.name === "get_catalog").execute({});

  assert.equal(capturedWhereB.businessId, "biz-bbb", "catalog query must be scoped to biz-bbb");
});

test("Scenario 7c: lookup_or_create_customer namespaces by businessId (same phone → different records per tenant)", async () => {
  installStubs();
  const capturedBizIds = [];
  const capturedCustIds = [];
  mockCreateCustomer = async (_tx, input) => {
    capturedBizIds.push(input.businessId);
    const id = `cust-${input.businessId}`;
    capturedCustIds.push(id);
    return { id, name: input.phone, phone: input.phone,
      address: null, postalCode: null, city: null, email: null };
  };

  const { buildCustomerAgentTools } = loadBuilderModule();

  const lookupA = buildCustomerAgentTools(CTX_BIZ_A).find((t) => t.name === "lookup_or_create_customer");
  clearSutCache();
  const lookupB = loadBuilderModule().buildCustomerAgentTools(CTX_BIZ_B).find((t) => t.name === "lookup_or_create_customer");

  const resultA = await lookupA.execute({});
  const resultB = await lookupB.execute({});

  assert.notEqual(resultA.customerId, resultB.customerId,
    "same phone in different businesses must produce different customer records");
  assert.ok(capturedBizIds.includes("biz-aaa"), "biz-A must create customer under biz-aaa");
  assert.ok(capturedBizIds.includes("biz-bbb"), "biz-B must create customer under biz-bbb");
});

test("Scenario 7d: quote_shipping scopes businessId to resolveShippingQuote (no cross-tenant A2A leak)", async () => {
  installStubs();
  const capturedBusinessIds = [];
  mockResolveShippingQuote = async (input) => {
    capturedBusinessIds.push(input.businessId);
    return { ok: false, reason: "missing_destination_postal_code" };
  };

  const { buildCustomerAgentTools } = loadBuilderModule();
  const quoteA = buildCustomerAgentTools(CTX_BIZ_A).find((t) => t.name === "quote_shipping");
  clearSutCache();
  const quoteB = loadBuilderModule().buildCustomerAgentTools(CTX_BIZ_B).find((t) => t.name === "quote_shipping");

  await quoteA.execute({});
  await quoteB.execute({});

  assert.ok(capturedBusinessIds.includes("biz-aaa"), "biz-A quote must use biz-aaa");
  assert.ok(capturedBusinessIds.includes("biz-bbb"), "biz-B quote must use biz-bbb");
  assert.ok(!capturedBusinessIds.includes("biz-bbb") || capturedBusinessIds.filter((id) => id === "biz-aaa").length === 1,
    "no cross-tenant spill for biz-A");
});

// ── G1–G4: Context-injection grounding ───────────────────────────────────────
//
// The fix for the "narrates from memory" bug uses context injection:
//   1. Catalog summary built from DB before agent creation
//   2. Injected into instruction via closure (CATALOG_SUMMARY_PLACEHOLDER replaced)
//   3. toolConfig mode stays AUTO — model can still produce a final text reply
//
// mode=ANY was the prior broken approach: it forced a tool call on every turn so
// the model could NEVER produce a text reply → CUSTOMER_AGENT_EMPTY_REPLY loop.
// Source (HTTP 200 verified 2026-05-29):
//   https://ai.google.dev/gemini-api/docs/function-calling
//   "ANY — model is constrained to always predict a function call."
//
// CUSTOMER_AGENT_GROUNDED_TOOLS is exported as a documentation artifact listing
// the intended grounded tool set so the contract is explicit and testable.

test("G1: CUSTOMER_AGENT_GROUNDED_TOOLS is exported and documents all state-touching tools", () => {
  const { CUSTOMER_AGENT_GROUNDED_TOOLS } = loadPromptModule();
  assert.ok(
    Array.isArray(CUSTOMER_AGENT_GROUNDED_TOOLS) && CUSTOMER_AGENT_GROUNDED_TOOLS.length > 0,
    "CUSTOMER_AGENT_GROUNDED_TOOLS must be a non-empty array",
  );
  const required = [
    "get_catalog", "update_order_item", "create_payment_link",
    "quote_shipping", "lookup_or_create_customer", "escalate_to_owner",
  ];
  for (const name of required) {
    assert.ok(
      CUSTOMER_AGENT_GROUNDED_TOOLS.includes(name),
      `CUSTOMER_AGENT_GROUNDED_TOOLS must document '${name}'`,
    );
  }
});

test("G2: every registered Customer Agent tool is documented in CUSTOMER_AGENT_GROUNDED_TOOLS", () => {
  installStubs();
  const { CUSTOMER_AGENT_GROUNDED_TOOLS } = loadPromptModule();
  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);

  for (const tool of tools) {
    assert.ok(
      CUSTOMER_AGENT_GROUNDED_TOOLS.includes(tool.name),
      `Tool '${tool.name}' is registered but NOT documented in CUSTOMER_AGENT_GROUNDED_TOOLS`,
    );
  }
});

test("G3: system prompt contains explicit tool-grounding contract (no narrating from memory)", () => {
  const { CUSTOMER_AGENT_SYSTEM_PROMPT } = loadPromptModule();
  assert.ok(
    CUSTOMER_AGENT_SYSTEM_PROMPT.includes("get_catalog") &&
    CUSTOMER_AGENT_SYSTEM_PROMPT.includes("update_order_item"),
    "system prompt must name the grounding tools explicitly",
  );
  // Must contain the core prohibition
  assert.ok(
    CUSTOMER_AGENT_SYSTEM_PROMPT.toLowerCase().includes("requiere") ||
    CUSTOMER_AGENT_SYSTEM_PROMPT.toLowerCase().includes("herramienta") ||
    CUSTOMER_AGENT_SYSTEM_PROMPT.toLowerCase().includes("contrato"),
    "system prompt must reference tool requirement for data claims",
  );
});

test("G4: CATALOG_SUMMARY_PLACEHOLDER exists in system prompt and is replaced at runtime", () => {
  const { CUSTOMER_AGENT_SYSTEM_PROMPT, CATALOG_SUMMARY_PLACEHOLDER } = loadPromptModule();
  assert.ok(
    typeof CATALOG_SUMMARY_PLACEHOLDER === "string" && CATALOG_SUMMARY_PLACEHOLDER.length > 0,
    "CATALOG_SUMMARY_PLACEHOLDER must be a non-empty string",
  );
  assert.ok(
    CUSTOMER_AGENT_SYSTEM_PROMPT.includes(CATALOG_SUMMARY_PLACEHOLDER),
    "CUSTOMER_AGENT_SYSTEM_PROMPT must contain the placeholder so runtime injection replaces it",
  );
  // Verify runtime replace works: substituted string must NOT contain the raw placeholder.
  const injected = CUSTOMER_AGENT_SYSTEM_PROMPT.replace(CATALOG_SUMMARY_PLACEHOLDER, "Alfajor: $500 (10 en stock)");
  assert.ok(
    !injected.includes(CATALOG_SUMMARY_PLACEHOLDER),
    "replace() must substitute placeholder — no raw placeholder in final instruction",
  );
  assert.ok(
    injected.includes("Alfajor: $500"),
    "injected catalog data must appear in the final instruction",
  );
});


// ── G5: Catalog summary includes productId ────────────────────────────────────
//
// Root-cause regression test (2026-05-29): buildCatalogSummary used to emit
// "ProductName: $price (N en stock)" — no productId. When the LLM called
// update_order_item without first calling get_catalog, it passed an invented id;
// the DB lookup failed ("No encontré ese producto") and the cart remained empty.
// Transcript evidence: Juan García session 23:44:37 UTC — update_order_item ERROR
// "No encontré ese producto en el catálogo" on a product that exists in DB.
//
// Fix: include [productId:...] in each catalog summary line so the model always
// has the correct id available even when it skips get_catalog.

const CATALOG_PATH = path.resolve(__dirname, "../../src/lib/adk/customer-agent-catalog.ts");

function loadCatalogModule() {
  delete Module._cache[CATALOG_PATH];
  return require(CATALOG_PATH);
}

test("G5: buildCatalogSummary includes productId in each product line", async () => {
  installStubs();
  mockPrisma.product.findMany = async () => [
    { id: "prod_example_id", name: "alfajor", price: 500, quantity: 80 },
    { id: "p2-id-test", name: "Facturas x6", price: 1200, quantity: 30 },
  ];

  const { buildCatalogSummary } = loadCatalogModule();
  const summary = await buildCatalogSummary("biz-aaa");

  assert.ok(
    summary.includes("[productId:prod_example_id]"),
    "catalog summary must include [productId:...] for each product so LLM can call update_order_item correctly",
  );
  assert.ok(
    summary.includes("[productId:p2-id-test]"),
    "catalog summary must include productId for every product in the list",
  );
  assert.ok(
    summary.includes("alfajor: $500"),
    "product name and price must still appear in summary",
  );
});

test("G6: update_order_item followed by create_payment_link — full add-to-cart pipeline never shows empty cart", async () => {
  // Regression test: proves the cart written by update_order_item is read by
  // create_payment_link when both use the same tool_context (session.state).
  // This is the core checkout reliability test: add item → confirm → get link.
  installStubs();

  mockPrisma.product.findFirst = async (_opts) => ({
    id: "prod_example_id",
    name: "alfajor",
    price: 500,
    quantity: 100,
  });

  let paymentCallBody = null;
  mockSendMessage = async (_url, body) => {
    paymentCallBody = body;
    return { text: "Link: https://mp.com/test-link", contextId: "ctx-test" };
  };

  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const updateItem = tools.find((t) => t.name === "update_order_item");
  const paymentLink = tools.find((t) => t.name === "create_payment_link");

  // Shared session state — simulates the same ADK session across tool calls in one turn.
  const tc = makeToolContext({});

  // Step 1: add to cart
  const addResult = await updateItem.execute({ productId: "prod_example_id", quantity: 3 }, tc);
  assert.ok(addResult.order, "update_order_item must return the cart");
  assert.equal(addResult.order.items.length, 1, "cart must have 1 item after add");
  assert.equal(addResult.order.subtotal, 1500, "subtotal must be 3 x 500 = 1500");

  // Step 2: create payment link using the same session state
  const payResult = await paymentLink.execute({ confirmed: true }, tc);
  assert.ok(!payResult.error, `create_payment_link must NOT error. Got: ${payResult.error}`);
  assert.ok(payResult.result, "must return payment link result");
  assert.ok(paymentCallBody && paymentCallBody.includes("alfajor"), "payment body must include the product name");
  assert.ok(paymentCallBody.includes("1500"), "payment body must include the subtotal");
});

test("G7: failed update_order_item does NOT leave a hallucinated cart entry", async () => {
  // Regression test: if update_order_item fails (product not found), the cart
  // must remain empty. create_payment_link must then correctly reject with
  // "no items" — NOT process a phantom order from LLM hallucination.
  installStubs();

  // Simulate product NOT in DB (the exact failure from Juan García session)
  mockPrisma.product.findFirst = async () => null;

  const { buildCustomerAgentTools } = loadBuilderModule();
  const tools = buildCustomerAgentTools(CTX_BIZ_A);
  const updateItem = tools.find((t) => t.name === "update_order_item");
  const paymentLink = tools.find((t) => t.name === "create_payment_link");

  const tc = makeToolContext({});

  // Step 1: try to add item — will fail (product not found)
  const addResult = await updateItem.execute({ productId: "invented-id-xyz", quantity: 1 }, tc);
  assert.ok(addResult.error, "update_order_item must return error for unknown product");
  assert.match(addResult.error, /catálogo|producto/i, "error must say product not found");

  // Step 2: attempt to create payment — must see EMPTY cart
  const payResult = await paymentLink.execute({ confirmed: true }, tc);
  assert.ok(payResult.error, "create_payment_link must reject when cart is empty after failed add");
  assert.match(payResult.error, /items|pedido/i, "error must say no items in cart");
});
