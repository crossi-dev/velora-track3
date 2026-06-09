"use strict";
// Tests para getValidAccessToken (helper que slice 8 va a usar para llamar
// la API de MP con un accessToken vivo).
//
// Cubre:
//   - sin MP config → null.
//   - sin MpConnection → null.
//   - accessToken aún válido (>5 min de margen) → devuelve current.
//   - accessToken vencido → llama refresh, persiste tokens nuevos, devuelve fresco.
//   - refresh devuelve 401/invalid_grant → borra MpConnection + null.
//   - refresh devuelve 5xx → null pero NO borra (falla transitoria).

const test = require("node:test");
const assert = require("node:assert/strict");
const nodeCrypto = require("node:crypto");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

// Test-side mirror of the AES-256-GCM v1 format used by mp-token-cipher.ts.
// Required because connection rows now store ciphertext (post-commit 8a50e655)
// and getValidAccessToken's readAccessToken/readRefreshToken decrypts in place.
// Generate a key per-test, encrypt fixtures, then set MP_TOKEN_ENCRYPTION_KEY
// to the same value so decrypt() inside the SUT works.
function encryptForTest(plaintext, keyB64) {
  const key = Buffer.from(keyB64, "base64");
  const iv = nodeCrypto.randomBytes(12);
  const cipher = nodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${ct.toString("base64")}`;
}

function newKeyB64() {
  return nodeCrypto.randomBytes(32).toString("base64");
}

function makePrismaState(seed = {}) {
  return {
    connections: new Map(seed.connections ?? []),
    deletes: 0,
    updates: 0,
  };
}

function makePrisma(state) {
  return {
    mpConnection: {
      findUnique: async ({ where }) => {
        return state.connections.get(where.businessId) ?? null;
      },
      update: async ({ where, data }) => {
        const row = state.connections.get(where.businessId);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        state.updates++;
        return row;
      },
      delete: async ({ where }) => {
        const existed = state.connections.delete(where.businessId);
        if (existed) state.deletes++;
        return existed ? { businessId: where.businessId } : null;
      },
    },
  };
}

function loadFresh(mocks) {
  resetSourceModules();
  clearMockModules();
  for (const [request, exports] of Object.entries(mocks)) {
    setMockModule(request, exports);
  }
  return require("../../src/app/api/integrations/mp/_lib/refresh-token.ts");
}

function withMpEnv(env, fn) {
  const keys = ["MP_CLIENT_ID", "MP_CLIENT_SECRET", "MP_REDIRECT_URI"];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) {
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  });
}

const CONFIGURED_ENV = {
  MP_CLIENT_ID: "client",
  MP_CLIENT_SECRET: "secret",
  MP_REDIRECT_URI: "https://app/cb",
};

test("getValidAccessToken: MP no configurado → null", async () => {
  await withMpEnv({}, async () => {
    const state = makePrismaState();
    const { getValidAccessToken } = loadFresh({
      "@/lib/prisma": { prisma: makePrisma(state) },
    });
    const result = await getValidAccessToken("biz1");
    assert.equal(result, null);
  });
});

test("getValidAccessToken: sin MpConnection → null", async () => {
  await withMpEnv(CONFIGURED_ENV, async () => {
    const state = makePrismaState();
    const { getValidAccessToken } = loadFresh({
      "@/lib/prisma": { prisma: makePrisma(state) },
    });
    const result = await getValidAccessToken("biz1");
    assert.equal(result, null);
  });
});

test("getValidAccessToken: token vigente → devuelve actual sin tocar fetch", async () => {
  const prevEncKey = process.env.MP_TOKEN_ENCRYPTION_KEY;
  const keyB64 = newKeyB64();
  process.env.MP_TOKEN_ENCRYPTION_KEY = keyB64;
  try {
    await withMpEnv(CONFIGURED_ENV, async () => {
      const now = Date.now();
      const state = makePrismaState({
        connections: [
          [
            "biz1",
            {
              businessId: "biz1",
              accessTokenCiphertext: encryptForTest("fresh-token", keyB64),
              refreshTokenCiphertext: encryptForTest("rfr", keyB64),
              publicKey: "pub",
              scope: "read",
              liveMode: false,
              expiresAt: new Date(now + 60 * 60 * 1000),
            },
          ],
        ],
      });
      let fetchCalls = 0;
      const { getValidAccessToken } = loadFresh({
        "@/lib/prisma": { prisma: makePrisma(state) },
      });
      const result = await getValidAccessToken("biz1", {
        nowMs: now,
        fetchImpl: async () => {
          fetchCalls++;
          return new Response("{}", { status: 200 });
        },
      });
      assert.equal(result, "fresh-token");
      assert.equal(fetchCalls, 0);
      assert.equal(state.updates, 0);
    });
  } finally {
    if (prevEncKey === undefined) delete process.env.MP_TOKEN_ENCRYPTION_KEY;
    else process.env.MP_TOKEN_ENCRYPTION_KEY = prevEncKey;
  }
});

test("getValidAccessToken: token expirado → refresh y persiste tokens nuevos", async () => {
  // The refresh path calls encrypt() which requires MP_TOKEN_ENCRYPTION_KEY.
  // Set a valid 32-byte base64 key for this test only; restore in finally.
  const prevEncKey = process.env.MP_TOKEN_ENCRYPTION_KEY;
  const keyB64 = newKeyB64();
  process.env.MP_TOKEN_ENCRYPTION_KEY = keyB64;
  try {
    await withMpEnv(CONFIGURED_ENV, async () => {
      const now = Date.now();
      const state = makePrismaState({
        connections: [
          [
            "biz1",
            {
              businessId: "biz1",
              accessTokenCiphertext: encryptForTest("old-token", keyB64),
              refreshTokenCiphertext: encryptForTest("old-refresh", keyB64),
              publicKey: "old-pub",
              scope: "read",
              liveMode: false,
              // Vencido hace 1 min — bien dentro del margen de refresh.
              expiresAt: new Date(now - 60 * 1000),
            },
          ],
        ],
      });
      const { getValidAccessToken } = loadFresh({
        "@/lib/prisma": { prisma: makePrisma(state) },
      });
      const tokenResponse = {
        access_token: "new-token",
        refresh_token: "new-refresh",
        public_key: "new-pub",
        live_mode: true,
        user_id: 999,
        expires_in: 3600,
        scope: "offline_access",
      };
      const result = await getValidAccessToken("biz1", {
        nowMs: now,
        fetchImpl: async () =>
          new Response(JSON.stringify(tokenResponse), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      });
      assert.equal(result, "new-token");
      assert.equal(state.updates, 1);
      assert.equal(state.deletes, 0);
      const row = state.connections.get("biz1");
      assert.ok(
        typeof row.accessTokenCiphertext === "string" && row.accessTokenCiphertext.length > 0,
        "accessTokenCiphertext must be set after refresh",
      );
      assert.ok(
        typeof row.refreshTokenCiphertext === "string" && row.refreshTokenCiphertext.length > 0,
        "refreshTokenCiphertext must be set after refresh",
      );
      assert.equal(row.liveMode, true);
    });
  } finally {
    if (prevEncKey === undefined) {
      delete process.env.MP_TOKEN_ENCRYPTION_KEY;
    } else {
      process.env.MP_TOKEN_ENCRYPTION_KEY = prevEncKey;
    }
  }
});

// NOTE: soft-disconnect — 401 no longer hard-deletes MpConnection.
// As of refresh-token.ts (search: "Soft-disconnect"), a 401/invalid_grant
// marks the connection's expiresAt=now so subsequent getValidAccessToken()
// calls detect an expired token immediately. Hard delete would lose the
// externalPosId needed for idempotent POS re-provisioning. The connection
// row stays; the owner must re-authorize via OAuth. State: state.updates=1,
// state.deletes=0, row still present with new expiresAt.
test("getValidAccessToken: refresh 401 → soft-disconnect (expiresAt=now) + null", async () => {
  const prevEncKey = process.env.MP_TOKEN_ENCRYPTION_KEY;
  const keyB64 = newKeyB64();
  process.env.MP_TOKEN_ENCRYPTION_KEY = keyB64;
  try {
  await withMpEnv(CONFIGURED_ENV, async () => {
    const now = Date.now();
    const state = makePrismaState({
      connections: [
        [
          "biz1",
          {
            businessId: "biz1",
            accessTokenCiphertext: encryptForTest("old", keyB64),
            refreshTokenCiphertext: encryptForTest("old", keyB64),
            publicKey: null,
            scope: null,
            liveMode: false,
            expiresAt: new Date(now - 60 * 1000),
          },
        ],
      ],
    });
    const { getValidAccessToken } = loadFresh({
      "@/lib/prisma": { prisma: makePrisma(state) },
    });
    const result = await getValidAccessToken("biz1", {
      nowMs: now,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    });
    assert.equal(result, null);
    // Soft-disconnect: update called (expiresAt=now), NOT delete.
    assert.equal(state.updates, 1, "mpConnection.update must be called to mark expiresAt=now");
    assert.equal(state.deletes, 0, "mpConnection must NOT be deleted (soft-disconnect preserves externalPosId)");
    assert.ok(state.connections.has("biz1"), "connection row must still exist after soft-disconnect");
    // Verify expiresAt was updated to approximately now (within 5 s tolerance).
    const row = state.connections.get("biz1");
    assert.ok(
      row.expiresAt instanceof Date && Math.abs(row.expiresAt.getTime() - Date.now()) < 5000,
      "expiresAt must be updated to approximately now",
    );
  });
  } finally {
    if (prevEncKey === undefined) delete process.env.MP_TOKEN_ENCRYPTION_KEY;
    else process.env.MP_TOKEN_ENCRYPTION_KEY = prevEncKey;
  }
});

test("getValidAccessToken: refresh 5xx → null pero NO borra (falla transitoria)", async () => {
  const prevEncKey = process.env.MP_TOKEN_ENCRYPTION_KEY;
  const keyB64 = newKeyB64();
  process.env.MP_TOKEN_ENCRYPTION_KEY = keyB64;
  try {
  await withMpEnv(CONFIGURED_ENV, async () => {
    const now = Date.now();
    const state = makePrismaState({
      connections: [
        [
          "biz1",
          {
            businessId: "biz1",
            accessTokenCiphertext: encryptForTest("old", keyB64),
            refreshTokenCiphertext: encryptForTest("old", keyB64),
            publicKey: null,
            scope: null,
            liveMode: false,
            expiresAt: new Date(now - 60 * 1000),
          },
        ],
      ],
    });
    const { getValidAccessToken } = loadFresh({
      "@/lib/prisma": { prisma: makePrisma(state) },
    });
    const result = await getValidAccessToken("biz1", {
      nowMs: now,
      fetchImpl: async () =>
        new Response("oops", { status: 503 }),
    });
    assert.equal(result, null);
    assert.equal(state.deletes, 0, "5xx no debe borrar la conexión");
    assert.ok(state.connections.has("biz1"));
  });
  } finally {
    if (prevEncKey === undefined) delete process.env.MP_TOKEN_ENCRYPTION_KEY;
    else process.env.MP_TOKEN_ENCRYPTION_KEY = prevEncKey;
  }
});
