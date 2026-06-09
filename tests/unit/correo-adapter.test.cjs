"use strict";
// Unit tests — CorreoAdapter (Logística provider — Correo Argentino implementation)
//
// Verifies:
//   1. quote() with no credentials → returns empty options (graceful degradation)
//   2. quote() with credentials + mocked fetchRates → valid options shape
//   3. quote() when fetchRates throws → empty options (non-fatal)
//   4. create() → always returns JSON-RPC error (feature not supported by MiCorreo v1)
//   5. track() → always returns JSON-RPC error (no tracking endpoint in spec)
//   6. options are parseable by extractCheapestPrice (compare_rates compatibility)

const assert = require("node:assert/strict");
const test   = require("node:test");
const path   = require("node:path");
const Module = require("node:module");

// ── Module paths ──────────────────────────────────────────────────────────────

const CORREO_ADAPTER_PATH = path.resolve(
  __dirname,
  "../../src/app/api/agents/logistica/jsonrpc/_lib/providers/correo-adapter.ts",
);
const CORREO_CLIENT_PATH = path.resolve(
  __dirname,
  "../../src/app/api/agents/correo/_lib/correo-api-client.ts",
);

const LOADER_PATH    = require.resolve("@/infrastructure/courier/courier-credential-loader");
const CLOUD_LOG_PATH = require.resolve("@/lib/cloud-logger");

// ── Stub helpers ──────────────────────────────────────────────────────────────

function installCloudLogStub() {
  Module._cache[CLOUD_LOG_PATH] = {
    id: CLOUD_LOG_PATH, filename: CLOUD_LOG_PATH, loaded: true,
    exports: { cloudLog: () => {} },
  };
}

function installLoaderNoCredentials() {
  Module._cache[LOADER_PATH] = {
    id: LOADER_PATH, filename: LOADER_PATH, loaded: true,
    exports: {
      loadCorreoCredentials:   async () => null,
      loadOcaCredentials:      async () => null,
      loadAndreaniCredentials: async () => null,
    },
  };
}

function installLoaderWithCredentials() {
  Module._cache[LOADER_PATH] = {
    id: LOADER_PATH, filename: LOADER_PATH, loaded: true,
    exports: {
      loadCorreoCredentials: async () => ({
        username: "test@correo.com",
        password: "testpass",
        customerId: "CUST-001",
      }),
      loadOcaCredentials:      async () => null,
      loadAndreaniCredentials: async () => null,
    },
  };
}

function installCorreoClientStub(overrides = {}) {
  const defaults = {
    resolveToken:     async () => ({ accessToken: "tok", expiresAt: Date.now() + 300_000 }),
    fetchRates:       async () => [],
    fetchAgencies:    async () => [],
    fetchToken:       async () => ({ accessToken: "tok", expiresAt: Date.now() + 300_000 }),
    parseRateOptions: (raw) => (Array.isArray(raw) ? raw : []),
    CORREO_API_BASE:  "https://api.correoargentino.com.ar/micorreo/v1",
  };
  Module._cache[CORREO_CLIENT_PATH] = {
    id: CORREO_CLIENT_PATH, filename: CORREO_CLIENT_PATH, loaded: true,
    exports: { ...defaults, ...overrides },
  };
}

function loadAdapter() {
  installCloudLogStub();
  delete Module._cache[CORREO_ADAPTER_PATH];
  return require(CORREO_ADAPTER_PATH);
}

// ── extractCheapestPrice helper (mirrors compare_rates logic) ─────────────────

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

// ── Tests: no credentials ─────────────────────────────────────────────────────

test("CorreoAdapter.quote — no credentials → returns jsonrpc 2.0 with empty options (not an error)", async () => {
  installLoaderNoCredentials();
  installCorreoClientStub();
  const { CorreoAdapter } = loadAdapter();
  const adapter = new CorreoAdapter();
  const response = await adapter.quote({ originPostalCode: "1001", destinationPostalCode: "5000" }, BUSINESS_ID);
  assert.strictEqual(response.jsonrpc, "2.0");
  assert.ok("result" in response, "response must have result (not error)");
  const raw = response.result.result;
  assert.ok(raw && Array.isArray(raw.options), "result.result.options must be an array");
  assert.strictEqual(raw.options.length, 0, "no credentials → empty options");
  assert.strictEqual(raw.provider, "correo");
});

test("CorreoAdapter.quote — no credentials → parts text is valid JSON with empty options", async () => {
  installLoaderNoCredentials();
  installCorreoClientStub();
  const { CorreoAdapter } = loadAdapter();
  const adapter = new CorreoAdapter();
  const response = await adapter.quote({ originPostalCode: "1001", destinationPostalCode: "5000" }, BUSINESS_ID);
  assert.ok("result" in response);
  const parts = response.result.parts;
  assert.ok(Array.isArray(parts) && parts.length > 0, "result.parts must be non-empty");
  const parsed = JSON.parse(parts[0].text);
  assert.ok(Array.isArray(parsed.options));
  assert.strictEqual(parsed.options.length, 0);
});

// ── Tests: create / track always return error ─────────────────────────────────

test("CorreoAdapter.create — always returns JSON-RPC error (not supported by MiCorreo v1)", async () => {
  installLoaderNoCredentials();
  installCorreoClientStub();
  const { CorreoAdapter } = loadAdapter();
  const adapter = new CorreoAdapter();
  const response = await adapter.create({ saleId: "sale-001" }, BUSINESS_ID);
  assert.ok("error" in response, "must return error, not result");
  assert.strictEqual(response.error.code, -32603);
  assert.ok(typeof response.error.message === "string" && response.error.message.length > 0);
});

test("CorreoAdapter.track — always returns JSON-RPC error (no tracking endpoint in spec)", async () => {
  installLoaderNoCredentials();
  installCorreoClientStub();
  const { CorreoAdapter } = loadAdapter();
  const adapter = new CorreoAdapter();
  const response = await adapter.track({ trackingNumber: "CA-12345" }, BUSINESS_ID);
  assert.ok("error" in response, "must return error, not result");
  assert.strictEqual(response.error.code, -32603);
});

// ── Tests: with credentials ───────────────────────────────────────────────────

test("CorreoAdapter.quote — with credentials + fetchRates returns options → parseable by extractCheapestPrice", async () => {
  installLoaderWithCredentials();
  installCorreoClientStub({
    fetchRates: async () => [
      { service: "correo_d_encomienda", serviceLabel: "Encomienda Standard", priceARS: 2500, estimatedDays: 4 },
      { service: "correo_s_encomienda", serviceLabel: "Encomienda Sucursal",  priceARS: 1800, estimatedDays: 5 },
    ],
  });
  const { CorreoAdapter } = loadAdapter();
  const adapter = new CorreoAdapter();
  const response = await adapter.quote({ originPostalCode: "1001", destinationPostalCode: "5000", weightGrams: 500 }, BUSINESS_ID);
  assert.ok("result" in response);
  const parts = response.result.parts;
  assert.ok(Array.isArray(parts) && parts.length > 0);
  const cheapest = extractCheapestPrice(parts[0].text);
  assert.ok(typeof cheapest === "number" && cheapest > 0,
    `extractCheapestPrice must return a positive number, got: ${cheapest}`);
  assert.strictEqual(cheapest, 1800, "cheapest must be Sucursal at 1800");
});

test("CorreoAdapter.quote — fetchRates throws → returns empty options (non-fatal)", async () => {
  installLoaderWithCredentials();
  installCorreoClientStub({
    fetchRates: async () => { throw new Error("Correo API timeout"); },
  });
  const { CorreoAdapter } = loadAdapter();
  const adapter = new CorreoAdapter();
  const response = await adapter.quote({ originPostalCode: "1001", destinationPostalCode: "5000" }, BUSINESS_ID);
  assert.ok("result" in response, "must return result (not error) on transient API failure");
  const raw = response.result.result;
  assert.strictEqual(raw.options.length, 0, "tarifa failure → empty options, not throw");
  assert.strictEqual(raw.provider, "correo");
});

test("CorreoAdapter.quote — resolveToken returns null → returns empty options (graceful degradation)", async () => {
  installLoaderWithCredentials();
  installCorreoClientStub({
    resolveToken: async () => null,
  });
  const { CorreoAdapter } = loadAdapter();
  const adapter = new CorreoAdapter();
  const response = await adapter.quote({ originPostalCode: "1001", destinationPostalCode: "5000" }, BUSINESS_ID);
  assert.ok("result" in response, "token failure must degrade, not crash");
  const raw = response.result.result;
  assert.strictEqual(raw.options.length, 0);
});
