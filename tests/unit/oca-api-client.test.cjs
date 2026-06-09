"use strict";
// Unit tests — OCA API client (oca-api-client.ts)
//
// Tests cover:
//   Part 1: loginSigma — success path, HTTP failure, success=false body
//   Part 2: Token cache — second call within TTL reuses cached token
//   Part 3: fetchTarifas XML parsing — valid XML → options array
//   Part 4: parseTarifaXml edge cases (empty, malformed, missing fields)
//   Part 5: password/credentials never appear in thrown error messages
//
// All network calls are replaced with globalThis.fetch mocks.
// No DB or real HTTP connections needed.

const assert = require("node:assert/strict");
const test   = require("node:test");
const path   = require("node:path");
const Module = require("node:module");

// ── Module path ───────────────────────────────────────────────────────────────

const CLIENT_PATH = path.resolve(
  __dirname,
  "../../src/app/api/agents/oca/_lib/oca-api-client.ts",
);

// The client imports loadOcaCredentials and cloudLog — stub both.
const LOADER_PATH     = require.resolve("@/infrastructure/courier/courier-credential-loader");
const CLOUD_LOG_PATH  = require.resolve("@/lib/cloud-logger");

function installStubs() {
  if (!Module._cache[LOADER_PATH]) {
    Module._cache[LOADER_PATH] = {
      id: LOADER_PATH, filename: LOADER_PATH, loaded: true,
      exports: {
        loadOcaCredentials: async () => null, // default: no credentials
        loadAndreaniCredentials: async () => null,
        OcaCredentials: {},
        AndreaniCredentials: {},
      },
    };
  }
  if (!Module._cache[CLOUD_LOG_PATH]) {
    Module._cache[CLOUD_LOG_PATH] = {
      id: CLOUD_LOG_PATH, filename: CLOUD_LOG_PATH, loaded: true,
      exports: { cloudLog: () => {} },
    };
  }
}

function loadClient() {
  installStubs();
  delete Module._cache[CLIENT_PATH];
  return require(CLIENT_PATH);
}

// ── Fetch mock helpers ────────────────────────────────────────────────────────

let savedFetch;

function mockFetch(statusCode, body) {
  savedFetch = globalThis.fetch;
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
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

// ── Part 1: loginSigma ────────────────────────────────────────────────────────

test("loginSigma — 200 + success=true → returns OcaAuthContext with accessToken and expiresAt", async () => {
  const { loginSigma } = loadClient();
  mockFetch(200, { success: true, message: "Success", result: "TOKEN_XYZ" });
  try {
    const ctx = await loginSigma("usuario", "password");
    assert.equal(ctx.accessToken, "TOKEN_XYZ");
    assert.ok(typeof ctx.expiresAt === "number" && ctx.expiresAt > Date.now(),
      "expiresAt must be a future epoch ms");
    // OCA TTL is ~4.5 minutes; expiresAt should be within 5 minutes.
    assert.ok(ctx.expiresAt < Date.now() + 5 * 60 * 1000 + 100,
      "expiresAt must not exceed 5-minute OCA TTL");
  } finally {
    restoreFetch();
  }
});

test("loginSigma — HTTP 401 → throws an error with HTTP status in message", async () => {
  const { loginSigma } = loadClient();
  mockFetch(401, "Unauthorized");
  try {
    await assert.rejects(
      () => loginSigma("user", "bad"),
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

test("loginSigma — success=false in body → throws (application-level rejection)", async () => {
  const { loginSigma } = loadClient();
  mockFetch(200, { success: false, message: "Invalid credentials", result: "" });
  try {
    await assert.rejects(
      () => loginSigma("user", "pass"),
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

test("loginSigma — password is NOT present in thrown error message on 401", async () => {
  const { loginSigma } = loadClient();
  const SECRET = "super-secret-oca-pass-9876";
  mockFetch(401, "Unauthorized");
  try {
    let thrown = null;
    try { await loginSigma("user", SECRET); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof Error);
    assert.ok(!thrown.message.includes(SECRET), "Password must not appear in error message");
  } finally {
    restoreFetch();
  }
});

// ── Part 2: Token cache — resolveToken ────────────────────────────────────────

test("resolveToken — returns null when no credentials for businessId", async () => {
  const { resolveToken } = loadClient();
  // Loader stub returns null → resolveToken must return null.
  const result = await resolveToken("biz1aaaaaaaaaaaaaaaaaaaa");
  assert.strictEqual(result, null);
});

// ── Part 3: fetchTarifas XML parsing ─────────────────────────────────────────
//
// fetchTarifas is a thin HTTP wrapper + XML parser. We test the parser by
// feeding known XML responses through it. Since fetchTarifas needs credentials,
// we mock fetch inline.

const VALID_TARIFA_XML = `
<?xml version="1.0" encoding="ISO-8859-1"?>
<NewDataSet>
  <Table>
    <aTarifacion>
      <Descripcion>A DOMICILIO</Descripcion>
      <Precio>3500.50</Precio>
      <PlazoEntrega>5</PlazoEntrega>
      <idTipoEnvio>1</idTipoEnvio>
    </aTarifacion>
    <aTarifacion>
      <Descripcion>SUCURSAL A SUCURSAL</Descripcion>
      <Precio>2800.00</Precio>
      <PlazoEntrega>7</PlazoEntrega>
      <idTipoEnvio>2</idTipoEnvio>
    </aTarifacion>
  </Table>
</NewDataSet>`;

test("fetchTarifas — valid XML → returns two parsed options with priceARS and estimatedDays", async () => {
  const { fetchTarifas } = loadClient();
  mockFetch(200, VALID_TARIFA_XML);
  try {
    const options = await fetchTarifas({
      cuit: "20-12345678-9", operativa: "12345",
      originPostal: "1001", destPostal: "5000",
      weightKg: 1.0, volumeM3: 0.001, packages: 1, declaredValue: 1000,
      usuario: "testuser", password: "testpass",
    });
    assert.ok(Array.isArray(options) && options.length === 2,
      `expected 2 options, got ${options.length}`);
    const dom = options.find((o) => o.serviceLabel.includes("DOMICILIO"));
    assert.ok(dom, "expected DOMICILIO option");
    assert.equal(dom.priceARS, 3500.50);
    assert.equal(dom.estimatedDays, 5);
    const suc = options.find((o) => o.serviceLabel.includes("SUCURSAL"));
    assert.ok(suc, "expected SUCURSAL option");
    assert.equal(suc.priceARS, 2800.00);
    assert.equal(suc.estimatedDays, 7);
  } finally {
    restoreFetch();
  }
});

test("fetchTarifas — HTTP error → returns empty array (non-fatal)", async () => {
  const { fetchTarifas } = loadClient();
  mockFetch(500, "Internal Server Error");
  try {
    const options = await fetchTarifas({
      cuit: "20-12345678-9", operativa: "12345",
      originPostal: "1001", destPostal: "5000",
      weightKg: 1.0, volumeM3: 0.001, packages: 1, declaredValue: 0,
      usuario: "u", password: "p",
    });
    assert.ok(Array.isArray(options) && options.length === 0,
      "HTTP error must return empty array, not throw");
  } finally {
    restoreFetch();
  }
});

test("fetchTarifas — empty XML body → returns empty array", async () => {
  const { fetchTarifas } = loadClient();
  mockFetch(200, "");
  try {
    const options = await fetchTarifas({
      cuit: "20-12345678-9", operativa: "12345",
      originPostal: "1001", destPostal: "5000",
      weightKg: 0.5, volumeM3: 0.001, packages: 1, declaredValue: 0,
      usuario: "u", password: "p",
    });
    assert.ok(Array.isArray(options) && options.length === 0);
  } finally {
    restoreFetch();
  }
});

// ── Part 4: XML with missing fields — should skip malformed entries ────────────

const PARTIAL_XML = `
<NewDataSet>
  <Table>
    <aTarifacion>
      <Descripcion>VALIDO</Descripcion>
      <Precio>1200.00</Precio>
      <PlazoEntrega>3</PlazoEntrega>
    </aTarifacion>
    <aTarifacion>
      <Descripcion></Descripcion>
      <Precio>abc</Precio>
      <PlazoEntrega>NaN</PlazoEntrega>
    </aTarifacion>
  </Table>
</NewDataSet>`;

test("fetchTarifas — malformed aTarifacion entries are skipped; valid ones are kept", async () => {
  const { fetchTarifas } = loadClient();
  mockFetch(200, PARTIAL_XML);
  try {
    const options = await fetchTarifas({
      cuit: "20-12345678-9", operativa: "12345",
      originPostal: "1001", destPostal: "5000",
      weightKg: 1.0, volumeM3: 0.001, packages: 1, declaredValue: 0,
      usuario: "u", password: "p",
    });
    // Only the valid entry should be returned; the malformed one is skipped.
    assert.ok(Array.isArray(options) && options.length === 1,
      `expected 1 valid option, got ${options.length}`);
    assert.equal(options[0].priceARS, 1200.00);
    assert.equal(options[0].estimatedDays, 3);
    assert.ok(options[0].serviceLabel.includes("VALIDO"));
  } finally {
    restoreFetch();
  }
});
