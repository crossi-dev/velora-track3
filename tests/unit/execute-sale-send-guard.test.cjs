// Money-path guard: executeSaleSend must reject when matchedProductId is null
// (unresolved) or when it's a hallucinated ID not present in the catalog.
// Regression for revision-249 smoke failure: "tuerca" LLM fallback returned
// matchedProductId: null and the action proceeded to execution.

const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("path");

// ─── require.cache injection ─────────────────────────────────────────────────
// execute-sale-send.ts imports:
//   - employee-welcome.ts → @/lib/prisma → env.ts (throws on AUTH_SECRET)
//   - model.ts → companion-agent.ts → session-service.ts → @/lib/prisma
// Inject a stub for prisma BEFORE any real module is loaded so env.ts is
// never evaluated. Also stub markOnboardingTaskDone so the fire-and-forget
// call in the success path doesn't reach a real DB.
const ROOT = path.resolve(__dirname, "../..");

function injectCacheEntry(relPath, exports) {
  const absPath = path.join(ROOT, relPath);
  require.cache[absPath] = {
    id: absPath, filename: absPath, loaded: true,
    exports, parent: null, children: [], paths: [],
  };
  return absPath;
}

// register.cjs redirects "@/lib/prisma" → tests/_stubs/prisma.js (a Proxy with
// no-op methods). Inject into the RESOLVED stub path so the cache lookup finds
// our mock instead of the original Proxy. The execute-sale-send path only hits
// prisma via employee-welcome.ts (markOnboardingTaskDone), which we stub away
// directly, and via model.ts → adk/session-service.ts (transitive). The Proxy
// stub handles the model.ts chain fine since it never actually runs in tests
// (needsLlmFallback is false in all test cases).
const STUB_PRISMA_PATH = path.join(ROOT, "tests", "_stubs", "prisma.js");

const INJECTED = [
  // Ensure the shared prisma stub is available (it already handles all cases).
  // We don't override it here — the default Proxy is sufficient.
  // Stub employee-welcome to avoid its transitive prisma calls entirely.
  injectCacheEntry(path.join(ROOT, "src/app/api/business-assistant/_lib/employee-welcome.ts"), {
    markOnboardingTaskDone: async () => {},
    buildEmployeeOnboardingResponse: async () => ({ message: "", currentTask: null }),
  }),
];

const {
  executeSaleSend,
} = require("../../src/app/api/business-assistant/_lib/nlu/execute-sale-send.ts");

// Remove stubs after the real module has loaded; closure retains references.
for (const p of INJECTED) delete require.cache[p];

const CATALOG_PRODUCTS = [
  { id: "prod-real-001", name: "Tuerca M8", sku: null, price: 250, stock: 50 },
  { id: "prod-real-002", name: "Tornillo 3mm", sku: null, price: 120, stock: 100 },
];

const CATALOG_CUSTOMERS = [
  { id: "cli-001", name: "Juan Pérez" },
];

function makeIntent(overrides = {}) {
  return {
    kind: "sale_send",
    matchedProductId: "prod-real-001",
    matchedCustomerId: "cli-001",
    productName: "Tuerca M8",
    customerName: "Juan Pérez",
    productAmbiguous: false,
    customerAmbiguous: false,
    needsLlmFallback: false,
    ...overrides,
  };
}

function makeParams(overrides = {}) {
  return {
    text: "vendé una tuerca a Juan y mandáselo",
    recentHistory: [],
    context: {
      catalog: {
        customers: CATALOG_CUSTOMERS,
      },
    },
    productInfoDirectory: CATALOG_PRODUCTS,
    businessId: "biz-test-001",
    actorEmployeeId: "emp-test-001",
    actorUserId: "user-test-001",
    ...overrides,
  };
}

async function parseResponse(nextResponse) {
  // NextResponse.json stores the body; in test environment we read it back.
  const text = await nextResponse.text();
  return JSON.parse(text);
}

// ── null matchedProductId → clarification, no register_sale action ──────────

test("guard: null matchedProductId returns clarification without register_sale action", async () => {
  const intent = makeIntent({ matchedProductId: null, productName: "tuerca", needsLlmFallback: false });
  const res = await executeSaleSend(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(body.answer, "must return an answer");
  assert.ok(!body.actions, "must NOT emit actions when product is unresolved");
  // Answer should mention the product name
  assert.match(body.answer, /tuerca/i);
});

test("guard: null matchedProductId with no productName returns generic clarification", async () => {
  const intent = makeIntent({ matchedProductId: null, productName: null, needsLlmFallback: false });
  const res = await executeSaleSend(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(body.answer, "must return an answer");
  assert.ok(!body.actions, "must NOT emit actions");
  assert.match(body.answer, /producto/i);
});

// ── hallucinated ID (non-existent in catalog) → clarification ───────────────

test("guard: hallucinated matchedProductId (not in catalog) returns clarification", async () => {
  const intent = makeIntent({
    matchedProductId: "hallucinated-id-xyz-9999",
    productName: "Tuerca Inexistente",
    needsLlmFallback: false,
  });
  const res = await executeSaleSend(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(body.answer, "must return an answer");
  assert.ok(!body.actions, "must NOT emit actions for hallucinated product ID");
  assert.match(body.answer, /catálogo|producto/i);
});

// ── valid matchedProductId in catalog → action proceeds ─────────────────────

test("guard: valid matchedProductId in catalog proceeds normally (no rejection)", async () => {
  const intent = makeIntent({
    matchedProductId: "prod-real-001",
    matchedCustomerId: "cli-001",
    productName: "Tuerca M8",
    needsLlmFallback: false,
  });
  const res = await executeSaleSend(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(Array.isArray(body.actions), "valid product must emit actions");
  assert.equal(body.actions[0].type, "register_sale");
  assert.equal(body.actions[0].matchedProductId, "prod-real-001");
  assert.equal(body.actions[0].autoSend, true);
});

test("guard: valid matchedProductId in catalog emits saleDraft", async () => {
  const intent = makeIntent({
    matchedProductId: "prod-real-001",
    productName: "Tuerca M8",
    needsLlmFallback: false,
  });
  const res = await executeSaleSend(intent, makeParams());
  const body = await parseResponse(res);
  assert.ok(body.saleDraft, "valid product must include saleDraft");
  assert.equal(body.saleDraft.items[0].productId, "prod-real-001");
  assert.equal(body.saleDraft.total, 250);
});

// ── Picker chip round-trip: natural-string values ────────────────────────────
// Chip tap calls onSendChip(value) → handleGo(value) → re-enters
// /api/business-assistant as a new user message. Chip value must be a
// natural re-parseable command string, NOT an encoded ID, so the existing
// detectSaleSendFastPath resolves unambiguously on the second pass.
// Mirrors sale-payment-prompt.ts pattern ("vendí 2 alfajores en efectivo").

test("picker: product ambiguous → chip values are natural strings re-parseable by detectSaleSendFastPath", async () => {
  const { detectSaleSendFastPath } = require("../../src/app/api/business-assistant/_lib/nlu/detect-wrappers.ts");

  const intent = makeIntent({
    matchedProductId: null,
    productName: "",
    productAmbiguous: true,
    needsLlmFallback: false,
    productCandidates: [
      { id: "prod-real-001", name: "Tuerca M8" },
      { id: "prod-real-002", name: "Tornillo 3mm" },
    ],
    qty: 2,
  });

  const res = await executeSaleSend(intent, makeParams());
  const body = await parseResponse(res);

  assert.ok(body.chips, "product picker must return chips");
  assert.equal(body.chips.kind, "single");
  assert.equal(body.chips.options.length, 2);

  // Each chip value must re-parse as sale_send with a single unambiguous product.
  const nluCtx = {
    catalog: {
      products: CATALOG_PRODUCTS,
      customers: CATALOG_CUSTOMERS,
    },
    invoiceDirectory: [],
    purchaseRequestDirectory: [],
  };

  for (const opt of body.chips.options) {
    // Value must NOT contain raw IDs or encoded separators.
    assert.ok(!opt.value.includes("producto_sale_send:"), `encoded ID in chip value: ${opt.value}`);
    assert.ok(!opt.value.includes(":"), `colon-encoded chip value: ${opt.value}`);

    // Re-run the fast-path detector as if the user tapped the chip.
    const reParsed = detectSaleSendFastPath(opt.value, nluCtx);
    assert.ok(reParsed, `chip value "${opt.value}" did not re-detect as sale_send`);
    assert.equal(reParsed.kind, "sale_send");
    assert.ok(reParsed.matchedProductId, `chip "${opt.value}" must resolve to an unambiguous product`);
    assert.ok(!reParsed.productAmbiguous, `chip "${opt.value}" must not be ambiguous on re-parse`);
  }
});

test("picker: customer ambiguous → chip values are natural strings re-parseable by detectSaleSendFastPath", async () => {
  const { detectSaleSendFastPath } = require("../../src/app/api/business-assistant/_lib/nlu/detect-wrappers.ts");

  const MULTI_CUSTOMERS = [
    { id: "cli-001", name: "Juan Pérez" },
    { id: "cli-002", name: "Juan García" },
  ];

  const intent = makeIntent({
    matchedProductId: "prod-real-001",
    matchedCustomerId: null,
    productName: "Tuerca M8",
    customerAmbiguous: true,
    needsLlmFallback: false,
    customerCandidates: [
      { id: "cli-001", name: "Juan Pérez" },
      { id: "cli-002", name: "Juan García" },
    ],
    qty: 3,
  });

  const params = makeParams({
    context: { catalog: { customers: MULTI_CUSTOMERS } },
  });

  const res = await executeSaleSend(intent, params);
  const body = await parseResponse(res);

  assert.ok(body.chips, "customer picker must return chips");
  assert.equal(body.chips.kind, "single");
  assert.equal(body.chips.options.length, 2);

  const nluCtx = {
    catalog: {
      products: CATALOG_PRODUCTS,
      customers: MULTI_CUSTOMERS,
    },
    invoiceDirectory: [],
    purchaseRequestDirectory: [],
  };

  for (const opt of body.chips.options) {
    // Value must NOT contain raw IDs or encoded separators.
    assert.ok(!opt.value.includes("cliente_sale_send:"), `encoded ID in chip value: ${opt.value}`);
    assert.ok(!opt.value.includes(":"), `colon-encoded chip value: ${opt.value}`);

    // Re-run the fast-path detector as if the user tapped the chip.
    const reParsed = detectSaleSendFastPath(opt.value, nluCtx);
    assert.ok(reParsed, `chip value "${opt.value}" did not re-detect as sale_send`);
    assert.equal(reParsed.kind, "sale_send");
    assert.ok(reParsed.matchedProductId, `chip "${opt.value}" must resolve product`);
    assert.ok(reParsed.matchedCustomerId, `chip "${opt.value}" must resolve to an unambiguous customer`);
    assert.ok(!reParsed.customerAmbiguous, `chip "${opt.value}" must not be customer-ambiguous on re-parse`);
  }
});
