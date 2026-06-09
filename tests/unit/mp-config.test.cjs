"use strict";
// Tests para getMpConfig — slice 7 del módulo Cobro QR.
// La función lee MP_CLIENT_ID / MP_CLIENT_SECRET / MP_REDIRECT_URI desde el
// process.env y reporta isConfigured solo si las tres están seteadas.

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const MODULE_PATH = "../../src/app/api/integrations/mp/_lib/config.ts";
const DEMO_BIZ_STUB_PATH = require.resolve("@/lib/demo-business");

function installDemoBizStub(isDemoFn) {
  Module._cache[DEMO_BIZ_STUB_PATH] = {
    id: DEMO_BIZ_STUB_PATH,
    filename: DEMO_BIZ_STUB_PATH,
    loaded: true,
    exports: { isDemoBusiness: isDemoFn },
  };
}

function loadFresh() {
  const resolved = require.resolve(MODULE_PATH);
  delete require.cache[resolved];
  // Default: no business is a demo business.
  installDemoBizStub(() => false);
  return require(MODULE_PATH);
}

function loadFreshWithDemo(demoBizId) {
  const resolved = require.resolve(MODULE_PATH);
  delete require.cache[resolved];
  installDemoBizStub((id) => id === demoBizId);
  return require(MODULE_PATH);
}

function withEnv(env, fn) {
  const keys = ["MP_CLIENT_ID", "MP_CLIENT_SECRET", "MP_REDIRECT_URI"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test("getMpConfig: env vars vacías → isConfigured=false", () => {
  withEnv({}, () => {
    const { getMpConfig } = loadFresh();
    const cfg = getMpConfig();
    assert.equal(cfg.isConfigured, false);
    assert.equal(cfg.clientId, "");
    assert.equal(cfg.clientSecret, "");
    assert.equal(cfg.redirectUri, "");
  });
});

test("getMpConfig: solo client_id seteado → isConfigured=false", () => {
  withEnv({ MP_CLIENT_ID: "abc123" }, () => {
    const { getMpConfig } = loadFresh();
    const cfg = getMpConfig();
    assert.equal(cfg.isConfigured, false);
    assert.equal(cfg.clientId, "abc123");
  });
});

test("getMpConfig: tres vars seteadas → isConfigured=true", () => {
  withEnv(
    {
      MP_CLIENT_ID: "abc123",
      MP_CLIENT_SECRET: "supersecret",
      MP_REDIRECT_URI: "https://example.com/cb",
    },
    () => {
      const { getMpConfig } = loadFresh();
      const cfg = getMpConfig();
      assert.equal(cfg.isConfigured, true);
      assert.equal(cfg.clientId, "abc123");
      assert.equal(cfg.clientSecret, "supersecret");
      assert.equal(cfg.redirectUri, "https://example.com/cb");
    },
  );
});

test("getMpConfig: env var con whitespace alrededor → trimmed", () => {
  withEnv(
    {
      MP_CLIENT_ID: "  abc123  ",
      MP_CLIENT_SECRET: " sec ",
      MP_REDIRECT_URI: "  https://x.com  ",
    },
    () => {
      const { getMpConfig } = loadFresh();
      const cfg = getMpConfig();
      assert.equal(cfg.isConfigured, true);
      assert.equal(cfg.clientId, "abc123");
      assert.equal(cfg.clientSecret, "sec");
      assert.equal(cfg.redirectUri, "https://x.com");
    },
  );
});

test("getMpConfig: env var con solo whitespace → no cuenta", () => {
  withEnv(
    {
      MP_CLIENT_ID: "abc",
      MP_CLIENT_SECRET: "   ",
      MP_REDIRECT_URI: "https://x.com",
    },
    () => {
      const { getMpConfig } = loadFresh();
      const cfg = getMpConfig();
      assert.equal(cfg.isConfigured, false);
    },
  );
});

test("buildMpAuthorizationUrl: genera la URL canónica con params codificados", () => {
  const { buildMpAuthorizationUrl } = loadFresh();
  const url = buildMpAuthorizationUrl({
    clientId: "abc",
    redirectUri: "https://example.com/cb?x=1",
    state: "s tate",
  });
  assert.ok(url.startsWith("https://auth.mercadopago.com.ar/authorization?"));
  assert.match(url, /client_id=abc/);
  assert.match(url, /response_type=code/);
  assert.match(url, /platform_id=mp/);
  assert.match(url, /state=s\+tate/);
  assert.match(url, /redirect_uri=https%3A%2F%2Fexample\.com%2Fcb%3Fx%3D1/);
});

test("isMpTokenResponse: rechaza shape inválido", () => {
  const { isMpTokenResponse } = loadFresh();
  assert.equal(isMpTokenResponse(null), false);
  assert.equal(isMpTokenResponse({}), false);
  assert.equal(isMpTokenResponse({ access_token: "x" }), false);
  assert.equal(
    isMpTokenResponse({
      access_token: "x",
      refresh_token: "y",
      expires_in: 3600,
      user_id: 12345,
    }),
    true,
  );
  assert.equal(
    isMpTokenResponse({
      access_token: "x",
      refresh_token: "y",
      expires_in: 3600,
      user_id: "12345",
    }),
    true,
  );
});

// ── Per-business gate: isMpMockActive ─────────────────────────────────────────

function withMockEnv(env, fn) {
  const keys = ["MP_MOCK_MODE", "MP_ALLOW_MOCK_IN_PROD", "NODE_ENV"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

const DEMO_ID = "demobiz000000000000000001";
const REAL_ID = "realbiz000000000000000001";

test("isMpMockActive: no businessId + MP_MOCK_MODE=true (non-prod) → true (global flag)", () => {
  withMockEnv({ MP_MOCK_MODE: "true" }, () => {
    const { isMpMockActive } = loadFresh();
    assert.strictEqual(isMpMockActive(), true);
  });
});

test("isMpMockActive: demo businessId + MP_MOCK_MODE=true (non-prod) → true", () => {
  withMockEnv({ MP_MOCK_MODE: "true" }, () => {
    const { isMpMockActive } = loadFreshWithDemo(DEMO_ID);
    assert.strictEqual(isMpMockActive(DEMO_ID), true);
  });
});

test("isMpMockActive: non-demo businessId + MP_MOCK_MODE=true (non-prod) → false (real mode)", () => {
  withMockEnv({ MP_MOCK_MODE: "true" }, () => {
    const { isMpMockActive } = loadFreshWithDemo(DEMO_ID);
    assert.strictEqual(isMpMockActive(REAL_ID), false);
  });
});

test("isMpMockActive: MP_MOCK_MODE=false → false regardless of businessId", () => {
  withMockEnv({ MP_MOCK_MODE: "false" }, () => {
    const { isMpMockActive } = loadFreshWithDemo(DEMO_ID);
    assert.strictEqual(isMpMockActive(DEMO_ID), false);
    assert.strictEqual(isMpMockActive(), false);
  });
});

test("isMpMockActive: MP_MOCK_MODE absent → false regardless of businessId", () => {
  withMockEnv({}, () => {
    const { isMpMockActive } = loadFreshWithDemo(DEMO_ID);
    assert.strictEqual(isMpMockActive(DEMO_ID), false);
    assert.strictEqual(isMpMockActive(REAL_ID), false);
  });
});
