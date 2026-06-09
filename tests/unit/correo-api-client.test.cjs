"use strict";
// Unit tests — Correo Argentino API client (correo-api-client.ts)
//
// Tests cover:
//   Part 1: fetchToken — success path, HTTP failure, missing access_token
//   Part 2: resolveToken — null when no credentials, caches within TTL
//   Part 3: parseRateOptions — valid array, top-level array, empty, malformed
//   Part 4: fetchRates — success, HTTP error returns empty array
//   Part 5: password not in any thrown error message

const assert = require("node:assert/strict");
const test   = require("node:test");
const path   = require("node:path");
const Module = require("node:module");

// ── Module paths ──────────────────────────────────────────────────────────────

const CLIENT_PATH = path.resolve(
  __dirname,
  "../../src/app/api/agents/correo/_lib/correo-api-client.ts",
);

const LOADER_PATH    = require.resolve("@/infrastructure/courier/courier-credential-loader");
const CLOUD_LOG_PATH = require.resolve("@/lib/cloud-logger");

function installStubs(loaderOverrides = {}) {
  const defaultLoader = {
    loadCorreoCredentials: async () => null,
    loadOcaCredentials:    async () => null,
    loadAndreaniCredentials: async () => null,
  };
  Module._cache[LOADER_PATH] = {
    id: LOADER_PATH, filename: LOADER_PATH, loaded: true,
    exports: { ...defaultLoader, ...loaderOverrides },
  };
  if (!Module._cache[CLOUD_LOG_PATH]) {
    Module._cache[CLOUD_LOG_PATH] = {
      id: CLOUD_LOG_PATH, filename: CLOUD_LOG_PATH, loaded: true,
      exports: { cloudLog: () => {} },
    };
  }
}

function loadClient(loaderOverrides = {}) {
  installStubs(loaderOverrides);
  delete Module._cache[CLIENT_PATH];
  return require(CLIENT_PATH);
}

// ── Fetch mock helpers ────────────────────────────────────────────────────────

let savedFetch;

function mockFetch(statusCode, body) {
  savedFetch = globalThis.fetch;
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body ?? {});
  globalThis.fetch = async () => ({
    ok: statusCode >= 200 && statusCode < 300,
    status: statusCode,
    text: async () => bodyStr,
    json: async () => (bodyStr ? JSON.parse(bodyStr) : {}),
  });
}

function restoreFetch() {
  if (savedFetch !== undefined) globalThis.fetch = savedFetch;
}

// ── Part 1: fetchToken ────────────────────────────────────────────────────────

test("fetchToken — 200 with access_token → returns CorreoAuthContext with accessToken and expiresAt", async () => {
  const { fetchToken } = loadClient();
  mockFetch(200, { access_token: "TOKEN_CORREO_ABC", token_type: "Bearer", expires_in: 3600 });
  try {
    const ctx = await fetchToken("user@test.com", "password");
    assert.equal(ctx.accessToken, "TOKEN_CORREO_ABC");
    assert.ok(typeof ctx.expiresAt === "number" && ctx.expiresAt > Date.now(),
      "expiresAt must be a future epoch ms");
    // With 3600s TTL and 30s buffer, expiresAt ≈ now + 3570s
    assert.ok(ctx.expiresAt < Date.now() + 3600 * 1000 + 100, "expiresAt must not exceed TTL");
  } finally {
    restoreFetch();
  }
});

test("fetchToken — HTTP 401 → throws with status in message", async () => {
  const { fetchToken } = loadClient();
  mockFetch(401, "Unauthorized");
  try {
    await assert.rejects(
      () => fetchToken("user", "bad"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes("401"), `expected 401 in message, got: ${err.message}`);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("fetchToken — 200 but missing access_token → throws", async () => {
  const { fetchToken } = loadClient();
  mockFetch(200, { token_type: "Bearer" });
  try {
    await assert.rejects(
      () => fetchToken("user", "pass"),
      (err) => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.length > 0);
        return true;
      },
    );
  } finally {
    restoreFetch();
  }
});

test("fetchToken — password is NOT present in thrown error message on 401", async () => {
  const { fetchToken } = loadClient();
  const SECRET = "super-secret-correo-pass-abc123";
  mockFetch(401, "Unauthorized");
  try {
    let thrown = null;
    try { await fetchToken("user", SECRET); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof Error);
    assert.ok(!thrown.message.includes(SECRET), "Password must not appear in error message");
  } finally {
    restoreFetch();
  }
});

// ── Part 2: resolveToken ──────────────────────────────────────────────────────

test("resolveToken — returns null when no credentials for businessId", async () => {
  const { resolveToken } = loadClient({ loadCorreoCredentials: async () => null });
  const result = await resolveToken("biz1aaaaaaaaaaaaaaaaaaaa");
  assert.strictEqual(result, null);
});

test("resolveToken — returns token when credentials present + Token call succeeds", async () => {
  const { resolveToken } = loadClient({
    loadCorreoCredentials: async () => ({
      username: "test@correo.com",
      password: "testpass",
      customerId: "CUST-001",
    }),
  });
  mockFetch(200, { access_token: "TOK_NEW", token_type: "Bearer", expires_in: 3600 });
  try {
    const ctx = await resolveToken("biz2bbbbbbbbbbbbbbbbbbbb");
    assert.ok(ctx !== null, "token must not be null with valid credentials");
    assert.equal(ctx.accessToken, "TOK_NEW");
  } finally {
    restoreFetch();
  }
});

// ── Part 3: parseRateOptions ──────────────────────────────────────────────────

test("parseRateOptions — top-level array → returns parsed options", () => {
  const { parseRateOptions } = loadClient();
  const raw = [
    { deliveryType: "D", productType: "ENCOMIENDA", productName: "Encomienda Standard", price: 2500, minDeliveryDays: 3, maxDeliveryDays: 5 },
    { deliveryType: "S", productType: "ENCOMIENDA", productName: "Encomienda Sucursal",  price: 1800, minDeliveryDays: 4, maxDeliveryDays: 6 },
  ];
  const options = parseRateOptions(raw);
  assert.ok(Array.isArray(options) && options.length === 2, `expected 2 options, got ${options.length}`);
  const domicilio = options.find((o) => o.serviceLabel.includes("Standard"));
  assert.ok(domicilio, "expected Standard option");
  assert.equal(domicilio.priceARS, 2500);
  assert.equal(domicilio.estimatedDays, 4); // midpoint of 3+5
  const sucursal = options.find((o) => o.serviceLabel.includes("Sucursal"));
  assert.ok(sucursal, "expected Sucursal option");
  assert.equal(sucursal.priceARS, 1800);
  assert.equal(sucursal.estimatedDays, 5); // midpoint of 4+6
});

test("parseRateOptions — { rates: [...] } envelope → returns parsed options", () => {
  const { parseRateOptions } = loadClient();
  const raw = {
    rates: [
      { deliveryType: "D", productName: "Urgente4k", price: 4000, minDeliveryDays: 1, maxDeliveryDays: 3 },
    ],
  };
  const options = parseRateOptions(raw);
  // At minimum one option with the correct price must be present.
  const urgente = options.find((o) => o.priceARS === 4000);
  assert.ok(urgente, `expected an option with priceARS=4000, got ${JSON.stringify(options)}`);
  assert.ok(urgente.serviceLabel.includes("Urgente4k"), "serviceLabel must match productName");
  // estimatedDays is midpoint of (1+3)/2 = 2
  assert.equal(urgente.estimatedDays, 2, "estimatedDays must be midpoint of 1+3");
});

test("parseRateOptions — empty array → returns empty array", () => {
  const { parseRateOptions } = loadClient();
  assert.deepEqual(parseRateOptions([]), []);
});

test("parseRateOptions — items with price=0 or missing price are skipped", () => {
  const { parseRateOptions } = loadClient();
  const raw = [
    { deliveryType: "D", productName: "Zero Price", price: 0, minDeliveryDays: 3, maxDeliveryDays: 5 },
    { deliveryType: "S", productName: "Valid",       price: 1200, minDeliveryDays: 2, maxDeliveryDays: 4 },
    { deliveryType: "X", productName: "No Price"                                                          },
  ];
  const options = parseRateOptions(raw);
  assert.equal(options.length, 1, "only the valid-price option must be returned");
  assert.equal(options[0].priceARS, 1200);
});

// ── Part 4: fetchRates ────────────────────────────────────────────────────────

test("fetchRates — HTTP error → returns empty array (non-fatal)", async () => {
  const { fetchRates } = loadClient();
  mockFetch(500, "Internal Server Error");
  const ctx = { accessToken: "tok", expiresAt: Date.now() + 300_000 };
  try {
    const options = await fetchRates(
      { customerId: "C1", codigoPostalOrigen: "1001", codigoPostalDestino: "5000", peso: 1, largo: 20, alto: 10, ancho: 15 },
      ctx,
    );
    assert.ok(Array.isArray(options) && options.length === 0, "HTTP error must return empty array, not throw");
  } finally {
    restoreFetch();
  }
});

test("fetchRates — 200 with valid rates array → returns parsed options", async () => {
  const { fetchRates } = loadClient();
  mockFetch(200, [
    { deliveryType: "D", productName: "Encomienda Standard", price: 2200, minDeliveryDays: 2, maxDeliveryDays: 4 },
  ]);
  const ctx = { accessToken: "tok", expiresAt: Date.now() + 300_000 };
  try {
    const options = await fetchRates(
      { customerId: "C1", codigoPostalOrigen: "1001", codigoPostalDestino: "5000", peso: 1, largo: 20, alto: 10, ancho: 15 },
      ctx,
    );
    assert.ok(Array.isArray(options) && options.length === 1);
    assert.equal(options[0].priceARS, 2200);
  } finally {
    restoreFetch();
  }
});
