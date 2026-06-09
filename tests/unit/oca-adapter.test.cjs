// Unit tests — OcaAdapter (Logística provider — real OCA API implementation)
//
// Verifies:
//   1. quote() with no credentials → returns empty options (graceful degradation, not an error)
//   2. quote() with credentials + mocked successful fetchTarifas → valid options shape
//   3. create() with no credentials → returns JSON-RPC error (code -32603)
//   4. track() with no credentials → returns JSON-RPC error (code -32603)
//   5. Factory wires "oca" → OcaAdapter (env-var test)
//   6. create() with missing saleId → returns JSON-RPC error (code -32602)
//   7. create() with existing OcaShipment row → returns cached tracking without calling OCA API (dedup guard)
//   8. create() atomic path — P2002 on prisma.create → returns winning row (race resolved)
//   9. create() missing postalCode → returns JSON-RPC error (code -32602) before calling OCA API
//
// Credentials are mocked via Module._cache stub for courier-credential-loader.
// OCA API network calls are mocked via globalThis.fetch.

"use strict";

const assert = require("node:assert/strict");
const test   = require("node:test");
const path   = require("node:path");
const Module = require("node:module");

// ── Module paths ──────────────────────────────────────────────────────────────

const OCA_ADAPTER_PATH = path.resolve(__dirname, "../../src/app/api/agents/logistica/jsonrpc/_lib/providers/oca-adapter.ts");
const FACTORY_PATH     = path.resolve(__dirname, "../../src/app/api/agents/logistica/jsonrpc/_lib/logistica-provider.ts");
const ANDREANI_PATH    = path.resolve(__dirname, "../../src/app/api/agents/logistica/jsonrpc/_lib/providers/andreani-adapter.ts");
const MOCK_PATH        = path.resolve(__dirname, "../../src/app/api/agents/logistica/jsonrpc/_lib/providers/mock-adapter.ts");
const OCA_CLIENT_PATH  = path.resolve(__dirname, "../../src/app/api/agents/oca/_lib/oca-api-client.ts");

const LOADER_PATH    = require.resolve("@/infrastructure/courier/courier-credential-loader");
const ADAPTER_PATH   = require.resolve("@/infrastructure/courier/courier-credential.adapter");
const CLOUD_LOG_PATH = require.resolve("@/lib/cloud-logger");
const PRISMA_PATH    = require.resolve("@/lib/prisma");

// ── Stub helpers ──────────────────────────────────────────────────────────────

function installAdapterStubs() {
  if (!Module._cache[ANDREANI_PATH]) {
    Module._cache[ANDREANI_PATH] = {
      id: ANDREANI_PATH, filename: ANDREANI_PATH, loaded: true,
      exports: { AndreaniAdapter: class AndreaniAdapter {} },
    };
  }
  if (!Module._cache[MOCK_PATH]) {
    Module._cache[MOCK_PATH] = {
      id: MOCK_PATH, filename: MOCK_PATH, loaded: true,
      exports: { MockAdapter: class MockAdapter {} },
    };
  }
}

function installCloudLogStub() {
  Module._cache[CLOUD_LOG_PATH] = {
    id: CLOUD_LOG_PATH, filename: CLOUD_LOG_PATH, loaded: true,
    exports: { cloudLog: () => {} },
  };
}

/** Install loader stub returning null (no credentials). */
function installLoaderNoCredentials() {
  Module._cache[LOADER_PATH] = {
    id: LOADER_PATH, filename: LOADER_PATH, loaded: true,
    exports: {
      loadOcaCredentials: async () => null,
      loadAndreaniCredentials: async () => null,
    },
  };
}

/** Install loader stub returning valid OCA credentials. */
function installLoaderWithCredentials() {
  Module._cache[LOADER_PATH] = {
    id: LOADER_PATH, filename: LOADER_PATH, loaded: true,
    exports: {
      loadOcaCredentials: async () => ({
        usuario: "testuser", password: "testpass",
        cuit: "20-12345678-9", operativa: "99999", nroCuenta: "12345",
      }),
      loadAndreaniCredentials: async () => null,
    },
  };
}

/** Install a stub OCA API client that returns controlled data. */
function installOcaClientStub(overrides = {}) {
  const defaults = {
    resolveToken:             async () => ({ accessToken: "tok", expiresAt: Date.now() + 300_000 }),
    fetchTarifas:             async () => [],
    crearEnvio:               async () => ({ saleId: "s1", trackingNumber: "OCA-123", labelUrl: null, estimatedDelivery: null, service: "oca_test", provider: "oca" }),
    fetchEstadoActual:        async () => ({ success: true, message: "ok", result: { estado: "EN_TRANSITO", descripcionEstado: "En tránsito" } }),
    fetchHistorialSeguimiento: async () => ({ success: true, message: "ok", result: [{ estado: "INGRESADO", descripcionEstado: "Ingresado en sucursal", fechaEvento: "2026-05-19T10:00:00Z", sucursal: "SucursalA" }] }),
    loginSigma:               async () => ({ accessToken: "tok", expiresAt: Date.now() + 300_000 }),
    obtenerSucursales:        async () => [],
  };
  Module._cache[OCA_CLIENT_PATH] = {
    id: OCA_CLIENT_PATH, filename: OCA_CLIENT_PATH, loaded: true,
    exports: { ...defaults, ...overrides },
  };
}

/**
 * Install a prisma stub with controlled ocaShipment behaviour.
 * @param {object} opts
 * @param {any}      [opts.findFirstResult]   — value returned by findFirst (default null)
 * @param {Function} [opts.createImpl]        — override create(); default is no-op success
 */
function installPrismaOcaShipmentStub({ findFirstResult = null, createImpl = null } = {}) {
  function makeModel() {
    return {
      findMany: async () => [],
      findFirst: async () => null,
      findUnique: async () => null,
      create: async () => ({}),
      createMany: async () => ({ count: 0 }),
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      delete: async () => ({}),
      deleteMany: async () => ({ count: 0 }),
      upsert: async () => ({}),
      count: async () => 0,
      aggregate: async () => ({}),
    };
  }
  const prisma = new Proxy({}, {
    get(_, model) {
      if (model === "ocaShipment") {
        const base = makeModel();
        base.findFirst = async () => findFirstResult;
        if (createImpl) base.create = createImpl;
        return base;
      }
      return makeModel();
    },
  });
  Module._cache[PRISMA_PATH] = {
    id: PRISMA_PATH, filename: PRISMA_PATH, loaded: true,
    exports: { prisma },
  };
}

function loadOcaAdapter() {
  installCloudLogStub();
  // Clear both the adapter and its credential wrapper so the loader stub takes effect.
  delete Module._cache[ADAPTER_PATH];
  delete Module._cache[OCA_ADAPTER_PATH];
  return require(OCA_ADAPTER_PATH);
}

function loadFactory() {
  installAdapterStubs();
  delete Module._cache[FACTORY_PATH];
  return require(FACTORY_PATH);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Mirrors extractCheapestPrice logic from src/lib/shipping-quote.ts.
 */
function extractCheapestPrice(text) {
  try {
    const jsonStart = text.indexOf("{");
    if (jsonStart === -1) return null;
    const parsed = JSON.parse(text.slice(jsonStart));
    const items = Array.isArray(parsed.options)
      ? parsed.options
      : Array.isArray(parsed.services) ? parsed.services : [];
    if (items.length === 0) return null;
    const prices = items
      .map((s) => (typeof s.priceARS === "number" ? s.priceARS : typeof s.price === "number" ? s.price : null))
      .filter((p) => p !== null);
    return prices.length > 0 ? Math.min(...prices) : null;
  } catch {
    return null;
  }
}

const BUSINESS_ID = "biz1aaaaaaaaaaaaaaaaaaaa";

// ── Tests: no credentials (graceful degradation) ──────────────────────────────

test("OcaAdapter.quote — no credentials → returns jsonrpc 2.0 with empty options (not an error)", async () => {
  installLoaderNoCredentials();
  installOcaClientStub();
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.quote({ originPostalCode: "1001", destinationPostalCode: "5000" }, BUSINESS_ID);
  assert.strictEqual(response.jsonrpc, "2.0");
  assert.ok("result" in response, "response must have result (not error)");
  const raw = response.result.result;
  assert.ok(raw && Array.isArray(raw.options), "result.result.options must be an array");
  assert.strictEqual(raw.options.length, 0, "no credentials → empty options array");
  assert.strictEqual(raw.provider, "oca");
});

test("OcaAdapter.quote — no credentials → parts text is valid JSON with empty options", async () => {
  installLoaderNoCredentials();
  installOcaClientStub();
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.quote({ originPostalCode: "1001", destinationPostalCode: "5000" }, BUSINESS_ID);
  assert.ok("result" in response);
  const parts = response.result.parts;
  assert.ok(Array.isArray(parts) && parts.length > 0, "result.parts must be non-empty");
  const parsed = JSON.parse(parts[0].text);
  assert.ok(Array.isArray(parsed.options));
});

test("OcaAdapter.create — no credentials → returns JSON-RPC error (code -32603)", async () => {
  installLoaderNoCredentials();
  installOcaClientStub();
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.create({ saleId: "sale-001" }, BUSINESS_ID);
  assert.ok("error" in response, "must return error, not result");
  assert.strictEqual(response.error.code, -32603);
  assert.ok(typeof response.error.message === "string" && response.error.message.length > 0);
});

test("OcaAdapter.track — no credentials → returns JSON-RPC error (code -32603)", async () => {
  installLoaderNoCredentials();
  installOcaClientStub({ resolveToken: async () => null });
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.track({ trackingNumber: "OCA-12345" }, BUSINESS_ID);
  assert.ok("error" in response, "must return error, not result");
  assert.strictEqual(response.error.code, -32603);
});

test("OcaAdapter.track — missing trackingNumber → returns JSON-RPC error (code -32602)", async () => {
  installLoaderNoCredentials();
  installOcaClientStub();
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.track({}, BUSINESS_ID);
  assert.ok("error" in response, "must return error, not result");
  assert.strictEqual(response.error.code, -32602);
});

// ── Tests: with credentials (real API path) ───────────────────────────────────

test("OcaAdapter.quote — with credentials + fetchTarifas returns options → parseable by extractCheapestPrice", async () => {
  installLoaderWithCredentials();
  installOcaClientStub({
    fetchTarifas: async () => [
      { service: "oca_tipo_1", serviceLabel: "OCA A DOMICILIO", priceARS: 3500, estimatedDays: 5 },
      { service: "oca_tipo_2", serviceLabel: "OCA SUCURSAL",    priceARS: 2800, estimatedDays: 7 },
    ],
  });
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.quote({ originPostalCode: "1001", destinationPostalCode: "5000", weightGrams: 500 }, BUSINESS_ID);
  assert.ok("result" in response);
  const parts = response.result.parts;
  assert.ok(Array.isArray(parts) && parts.length > 0);
  const cheapest = extractCheapestPrice(parts[0].text);
  assert.ok(typeof cheapest === "number" && cheapest > 0,
    `extractCheapestPrice must return a positive number, got: ${cheapest}`);
  assert.strictEqual(cheapest, 2800, "cheapest must be the SUCURSAL option at 2800");
});

test("OcaAdapter.quote — fetchTarifas throws → returns empty options (non-fatal)", async () => {
  installLoaderWithCredentials();
  installOcaClientStub({
    fetchTarifas: async () => { throw new Error("OCA API timeout"); },
  });
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.quote({ originPostalCode: "1001", destinationPostalCode: "5000" }, BUSINESS_ID);
  assert.ok("result" in response, "must return result (not error) on transient API failure");
  const raw = response.result.result;
  assert.strictEqual(raw.options.length, 0, "tarifa failure → empty options, not throw");
});

test("OcaAdapter.track — with credentials → returns status and events", async () => {
  installLoaderWithCredentials();
  installOcaClientStub();
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.track({ trackingNumber: "OCA-12345" }, BUSINESS_ID);
  assert.ok("result" in response, "must return result, not error");
  const raw = response.result.result;
  assert.ok(typeof raw.status === "string", "status must be a string");
  assert.ok(Array.isArray(raw.events) && raw.events.length > 0, "events must be non-empty");
  assert.strictEqual(raw.provider, "oca");
});

// ── Tests: C-2 fix — saleId required + pre-call dedup guard ──────────────────

test("OcaAdapter.create — missing saleId → returns JSON-RPC error (code -32602)", async () => {
  installLoaderWithCredentials();
  installOcaClientStub();
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.create({}, BUSINESS_ID);
  assert.ok("error" in response, "must return error when saleId is absent");
  assert.strictEqual(response.error.code, -32602);
  assert.ok(response.error.message.includes("saleId"), "error message must mention saleId");
});

test("OcaAdapter.create — existing OcaShipment row → returns cached tracking without calling OCA API", async () => {
  installLoaderWithCredentials();
  // crearEnvio would throw if called — proves dedup guard short-circuits before the API call.
  installOcaClientStub({
    crearEnvio: async () => { throw new Error("OCA API must NOT be called on dedup hit"); },
  });
  // Inject a prisma stub that returns an existing shipment for this saleId.
  installPrismaOcaShipmentStub({
    findFirstResult: {
      trackingNumber: "OCA-CACHED-999",
      service: "oca_tipo_1",
      labelUrl: null,
    },
  });
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.create({ saleId: "sale-dedup-001" }, BUSINESS_ID);
  assert.ok("result" in response, "must return result (not error) on dedup hit");
  const raw = response.result.result;
  assert.strictEqual(raw.trackingNumber, "OCA-CACHED-999", "must return the cached trackingNumber");
  assert.strictEqual(raw.saleId, "sale-dedup-001");
  assert.strictEqual(raw.provider, "oca");
});

// ── Tests: CONFIRMED-1 — atomic create + P2002 race resolution ────────────────

test("OcaAdapter.create — P2002 on prisma.create → returns winning row (race resolved)", async () => {
  installLoaderWithCredentials();
  // crearEnvio succeeds — the OCA API call goes through.
  installOcaClientStub({
    crearEnvio: async () => ({
      saleId: "sale-race-001", trackingNumber: "OCA-FIRST-100",
      labelUrl: null, estimatedDelivery: null, service: "oca_tipo_1", provider: "oca",
    }),
  });
  // Simulate: create() throws P2002 (another request already inserted); findFirst returns the winner.
  const p2002 = Object.assign(new Error("Unique constraint failed on saleId"), { code: "P2002" });
  installPrismaOcaShipmentStub({
    findFirstResult: null,           // pre-call dedup: no existing row (both requests pass this)
    createImpl: async () => { throw p2002; },
  });
  // After P2002, the stub's findFirst returns the winning row.
  // Re-install with a findFirst that returns the race winner for the second call.
  const HELPERS_PATH = require.resolve("../../src/app/api/agents/logistica/jsonrpc/_lib/providers/oca-adapter-helpers.ts");
  delete Module._cache[HELPERS_PATH];
  // Override findFirst at the prisma level: first call = null (pre-call dedup), second call = winning row.
  let findFirstCallCount = 0;
  const prismaStub = new Proxy({}, {
    get(_, model) {
      if (model === "ocaShipment") {
        return {
          findMany:   async () => [],
          findFirst:  async () => {
            findFirstCallCount++;
            if (findFirstCallCount === 1) return null; // pre-call dedup: no existing row
            return { trackingNumber: "OCA-WINNER-200", service: "oca_tipo_1", labelUrl: null }; // race winner
          },
          findUnique: async () => null,
          create:     async () => { throw p2002; },
          createMany: async () => ({ count: 0 }),
          update:     async () => ({}),
          updateMany: async () => ({ count: 0 }),
          delete:     async () => ({}),
          deleteMany: async () => ({ count: 0 }),
          upsert:     async () => ({}),
          count:      async () => 0,
          aggregate:  async () => ({}),
        };
      }
      return { findMany: async () => [], findFirst: async () => null, findUnique: async () => null,
               create: async () => ({}), createMany: async () => ({ count: 0 }), update: async () => ({}),
               updateMany: async () => ({ count: 0 }), delete: async () => ({}), deleteMany: async () => ({ count: 0 }),
               upsert: async () => ({}), count: async () => 0, aggregate: async () => ({}) };
    },
  });
  Module._cache[require.resolve("@/lib/prisma")] = {
    id: require.resolve("@/lib/prisma"), filename: require.resolve("@/lib/prisma"), loaded: true,
    exports: { prisma: prismaStub },
  };
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.create({
    saleId: "sale-race-001",
    customer: { name: "Test", address: "Av. Test 123", postalCode: "1000" },
  }, BUSINESS_ID);
  assert.ok("result" in response, "must return result (not error) when P2002 race resolved");
  const raw = response.result.result;
  assert.strictEqual(raw.trackingNumber, "OCA-WINNER-200", "must return the winning row trackingNumber");
  assert.strictEqual(raw.provider, "oca");
});

// ── Tests: CONFIRMED-2 — postalCode required before crearEnvio ────────────────

test("OcaAdapter.create — missing postalCode → returns JSON-RPC error (code -32602) before calling OCA API", async () => {
  installLoaderWithCredentials();
  // crearEnvio would throw if called — proves the CP guard fires first.
  installOcaClientStub({
    crearEnvio: async () => { throw new Error("OCA API must NOT be called when postalCode is absent"); },
  });
  installPrismaOcaShipmentStub({ findFirstResult: null });
  const { OcaAdapter } = loadOcaAdapter();
  const adapter = new OcaAdapter();
  const response = await adapter.create({
    saleId: "sale-cp-test",
    customer: { name: "Test", address: "Calle 123" }, // no postalCode
  }, BUSINESS_ID);
  assert.ok("error" in response, "must return error when postalCode is absent");
  assert.strictEqual(response.error.code, -32602);
  assert.ok(
    response.error.message.toLowerCase().includes("postal") ||
    response.error.message.toLowerCase().includes("código"),
    `error message must mention postal code, got: ${response.error.message}`,
  );
});

// ── Registry test ─────────────────────────────────────────────────────────────

test("Courier registry: getCourierEntry('oca') → OcaAdapter instance", () => {
  installLoaderNoCredentials();
  installOcaClientStub();
  const REGISTRY_PATH = path.resolve(__dirname, "../../src/app/api/agents/logistica/jsonrpc/_lib/courier-registry.ts");
  const { OcaAdapter } = loadOcaAdapter();
  // Inject OcaAdapter into the module cache so the registry picks it up.
  Module._cache[OCA_ADAPTER_PATH] = {
    id: OCA_ADAPTER_PATH, filename: OCA_ADAPTER_PATH, loaded: true,
    exports: { OcaAdapter },
  };
  delete Module._cache[REGISTRY_PATH];
  const { getCourierEntry } = require(REGISTRY_PATH);
  const entry = getCourierEntry("oca");
  assert.ok(entry !== undefined, "oca entry must exist in registry");
  const adapter = entry.getAdapter();
  assert.ok(adapter instanceof OcaAdapter, "adapter must be an OcaAdapter instance");
});
