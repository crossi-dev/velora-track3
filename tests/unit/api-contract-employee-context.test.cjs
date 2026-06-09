"use strict";
// Contract test: GET /api/employee/context
// Verifies the response shape contract (Decimal→Number, Date→string, costPrice hidden)
// using require.cache injection to avoid a live DB.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Module = require("node:module");

const ROOT = path.resolve(__dirname, "../..");

// POLLUTION GUARD — module-hooks.cjs (loaded by sibling test files earlier in
// run-all.cjs) installs a Module._load interceptor that consults
// globalThis.__veloraPhase4ModuleHooks.mocks BEFORE Module._cache. Files like
// session-version.test.cjs call setMockModule("@/lib/prisma", { user-only })
// at top-level, leaving a stale mock that takes priority over our
// injectCacheEntry() calls below.
//
// Fix: use setMockModule (if available) to ensure our prisma mock wins the
// globalState.mocks race, then clear it immediately after the SUT loads so
// other files are not polluted.
let _setMockModule = (_k, _v) => {};
let _clearMockEntry = (_k) => {};
try {
  const hooks = require("../phase4/module-hooks.cjs");
  _setMockModule = hooks.setMockModule;
  // clearMockModules() would wipe ALL mocks (including entries that other files
  // still need). Instead, we surgically delete only the key we own.
  _clearMockEntry = (key) => {
    const gs = globalThis.__veloraPhase4ModuleHooks;
    if (gs && gs.mocks) gs.mocks.delete(key);
  };
} catch { /* module-hooks not available — isolated run, Module._cache suffices */ }

function makeDecimal(n) {
  return {
    toNumber: () => n,
    valueOf: () => n,
    toString: () => String(n),
    [Symbol.toPrimitive]: (hint) => (hint === "string" ? String(n) : n),
  };
}

const MOCK_BUSINESS = {
  id: "biz-contract-1",
  name: "Test Store",
  type: "retail",
  cuit: null,
  address: null,
  phone: null,
  email: null,
  whatsappPhone: null,
  openingTime: null,
  closingTime: null,
  currency: "ARS",
  taxRate: makeDecimal(0.21),
  workerCount: 2,
  openingCash: makeDecimal(5000),
  createdAt: new Date("2025-01-01T10:00:00.000Z"),
};

// Route selects quantity directly on Product (Inventory was merged into Product
// in commit 42085b00). The old mock had inventory: { quantity } which no longer
// matches the DB shape the route queries.
const MOCK_PRODUCTS = [
  {
    id: "prod-contract-1",
    name: "Coca Cola",
    price: makeDecimal(150),
    sku: "CC-1",
    quantity: 24,
  },
  {
    id: "prod-contract-2",
    name: "Sprite",
    price: makeDecimal(120),
    sku: null,
    quantity: 0,
  },
];

const MOCK_CUSTOMERS = [
  { id: "cust-contract-1", name: "Juan Pérez", phone: "+54911234567" },
  { id: "cust-contract-2", name: "María García", phone: null },
];

// Mutable so we can vary per test case
let currentActor = { actorUserId: "u-1", actorEmployeeId: "emp-1", businessId: "biz-contract-1", role: "employee" };
let currentBusiness = MOCK_BUSINESS;

function injectCacheEntry(absPath, exports) {
  require.cache[absPath] = {
    id: absPath,
    filename: absPath,
    loaded: true,
    exports,
    parent: null,
    children: [],
    paths: [],
  };
  return absPath;
}

// register.cjs redirects "@/lib/prisma" → tests/_stubs/prisma.js (a Proxy stub
// that prevents AUTH_SECRET/DATABASE_URL env throws at module load). For contract
// tests that need specific return values we MUST inject into the RESOLVED stub
// path, not into src/lib/prisma.ts, because _resolveFilename runs before the
// cache lookup so the cache key is the stub path, not the source path.
//
// Additionally, module-hooks._load intercepts "@/lib/prisma" BEFORE Module._cache
// is consulted, so we must also register the mock via setMockModule to ensure
// this file's prisma is used, not whatever was left by a prior test file.
//
// Route calls employee.findFirst (businessId-scoped) since commit c6da17df.
// Product.quantity is now a direct field on Product (Inventory merged in 42085b00).
const STUB_PRISMA_PATH = path.join(ROOT, "tests", "_stubs", "prisma.js");
const ACTOR_PATH = path.join(ROOT, "src", "app", "api", "_lib", "resolve-actor.ts");
const ROUTE_PATH = path.join(ROOT, "src", "app", "api", "employee", "context", "route.ts");

// Build the prisma mock object once. The route captures it by reference at load
// time via its `import { prisma }` — closure means currentBusiness / currentActor
// changes made after load are visible through the arrow functions.
const prismaMock = {
  business: { findUnique: async () => currentBusiness },
  product: { findMany: async () => MOCK_PRODUCTS },
  customer: { findMany: async () => MOCK_CUSTOMERS },
  // Route calls findFirst (not findUnique) — added businessId scoping in c6da17df
  employee: { findFirst: async () => ({ name: "Test Employee" }) },
  cashMovement: {
    findMany: async () => [],
    aggregate: async () => ({ _sum: { amount: null } }),
  },
  sale: { findMany: async () => [] },
};

// Register via setMockModule first so module-hooks._load returns our mock when
// the route does require("@/lib/prisma"), overriding any stale globalState.mocks
// entry left by prior test files. This must happen before the SUT require() below.
_setMockModule("@/lib/prisma", { prisma: prismaMock });

// Also inject into Module._cache at the stub path as a belt-and-suspenders
// fallback for isolated runs where module-hooks is not installed.
const injected = [
  injectCacheEntry(STUB_PRISMA_PATH, { prisma: prismaMock }),
  injectCacheEntry(ACTOR_PATH, {
    resolveActor: async () => currentActor,
  }),
];

// Clear the route from cache so it loads fresh with our mocks (not a stale
// version cached by employee-all-intents.test.cjs or other sibling files).
delete Module._cache[ROUTE_PATH];

const { GET } = require("../../src/app/api/employee/context/route.ts");

// Remove injected Module._cache entries so other tests don't see stale mocks.
// The loaded GET function retains references via closure so removing cache
// entries after load doesn't affect the already-captured mock objects.
for (const p of injected) delete require.cache[p];

// Remove our globalState.mocks entry so subsequent files are not polluted.
_clearMockEntry("@/lib/prisma");

function makeRequest() {
  return {
    url: "http://localhost/api/employee/context",
    headers: { get: () => null },
    nextUrl: new URL("http://localhost/api/employee/context"),
    cookies: { get: () => null, getAll: () => [] },
  };
}

// ── Auth guards ────────────────────────────────────────────────────────

const RESET_ACTOR = { actorUserId: "u-1", actorEmployeeId: "emp-1", businessId: "biz-contract-1", role: "employee" };

test("GET /employee/context — 401 when actor is null (no session)", async () => {
  currentActor = null;
  const res = await GET(makeRequest());
  currentActor = RESET_ACTOR;
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(typeof body.error, "string", "401 must include error string");
});

test("GET /employee/context — 401 for owner role", async () => {
  currentActor = { actorUserId: "u-owner", businessId: "biz-contract-1", role: "owner" };
  const res = await GET(makeRequest());
  currentActor = RESET_ACTOR;
  assert.equal(res.status, 401);
});

test("GET /employee/context — 404 when business row not found", async () => {
  currentBusiness = null;
  const res = await GET(makeRequest());
  currentBusiness = MOCK_BUSINESS;
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(typeof body.error, "string");
});

// ── Top-level shape ────────────────────────────────────────────────────

test("GET /employee/context — 200 with business, products, customers", async () => {
  const res = await GET(makeRequest());
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok("business" in body);
  assert.ok("products" in body);
  assert.ok("customers" in body);
  assert.ok("employee" in body, "response must include employee");
  assert.ok("cashMovements" in body, "response must include cashMovements");
  assert.ok("cashTotal" in body, "response must include cashTotal");
  assert.ok("sales" in body, "response must include sales");
});

test("GET /employee/context — employee.name is string", async () => {
  const body = await (await GET(makeRequest())).json();
  assert.strictEqual(typeof body.employee.name, "string");
  assert.strictEqual(body.employee.name, "Test Employee");
});

test("GET /employee/context — cashMovements is array, cashTotal is number", async () => {
  const body = await (await GET(makeRequest())).json();
  assert.ok(Array.isArray(body.cashMovements));
  assert.strictEqual(typeof body.cashTotal, "number");
  assert.strictEqual(body.cashTotal, 0);
});

test("GET /employee/context — sales is array", async () => {
  const body = await (await GET(makeRequest())).json();
  assert.ok(Array.isArray(body.sales));
});

// ── Business field contracts ───────────────────────────────────────────

test("GET /employee/context — business.taxRate is primitive number (Decimal→Number)", async () => {
  const body = await (await GET(makeRequest())).json();
  assert.strictEqual(typeof body.business.taxRate, "number");
  assert.strictEqual(body.business.taxRate, 0.21);
});

test("GET /employee/context — business.openingCash is primitive number (Decimal→Number)", async () => {
  const body = await (await GET(makeRequest())).json();
  assert.strictEqual(typeof body.business.openingCash, "number");
  assert.strictEqual(body.business.openingCash, 5000);
});

test("GET /employee/context — business.createdAt is ISO string (Date→string)", async () => {
  const body = await (await GET(makeRequest())).json();
  assert.strictEqual(typeof body.business.createdAt, "string");
  assert.ok(!Number.isNaN(Date.parse(body.business.createdAt)));
});

// ── Product field contracts ────────────────────────────────────────────

test("GET /employee/context — product.price is primitive number (Decimal→Number)", async () => {
  const body = await (await GET(makeRequest())).json();
  assert.strictEqual(typeof body.products[0].price, "number");
  assert.strictEqual(body.products[0].price, 150);
});

test("GET /employee/context — product.stock from inventory.quantity (Decimal→Number)", async () => {
  const body = await (await GET(makeRequest())).json();
  assert.strictEqual(body.products[0].stock, 24);
});

test("GET /employee/context — product.stock is 0 when inventory is null", async () => {
  const body = await (await GET(makeRequest())).json();
  assert.strictEqual(body.products[1].stock, 0);
});

test("GET /employee/context — product.costPrice always null (never sent to employees)", async () => {
  const body = await (await GET(makeRequest())).json();
  for (const p of body.products) assert.strictEqual(p.costPrice, null);
});

test("GET /employee/context — product.sku null when absent", async () => {
  const body = await (await GET(makeRequest())).json();
  assert.strictEqual(body.products[1].sku, null);
});

// ── Customer field contracts ───────────────────────────────────────────

test("GET /employee/context — customer.phone null-coalesced", async () => {
  const body = await (await GET(makeRequest())).json();
  const withPhone = body.customers.find((c) => c.id === "cust-contract-1");
  const noPhone = body.customers.find((c) => c.id === "cust-contract-2");
  assert.strictEqual(withPhone.phone, "+54911234567");
  assert.strictEqual(noPhone.phone, null);
});

test("GET /employee/context — customer.email always null (not fetched)", async () => {
  const body = await (await GET(makeRequest())).json();
  for (const c of body.customers) assert.strictEqual(c.email, null);
});

test("GET /employee/context — customer.taxId always null (not fetched)", async () => {
  const body = await (await GET(makeRequest())).json();
  for (const c of body.customers) assert.strictEqual(c.taxId, null);
});
