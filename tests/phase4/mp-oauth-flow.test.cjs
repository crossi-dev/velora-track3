"use strict";
// Integration test del OAuth Mercado Pago — slice 7 del módulo Cobro QR.
//
// Cubre:
//   1. /connect: env vars vacías → 503 con MP_NOT_CONFIGURED.
//   2. /connect: configurado → 302 a auth.mercadopago.com.ar + state persistido.
//   3. /callback: state inexistente → redirect a /dashboard?...mp=invalid.
//   4. /callback: happy path → upsert MpConnection + redirect mp=connected.
//   5. /disconnect: borra MpConnection + audit + idempotency.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("./module-hooks.cjs");

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function redirectResponse(url, status = 302) {
  return new Response(null, { status, headers: { location: String(url) } });
}

function makeNextServerMock() {
  return {
    NextRequest: class NextRequest {},
    NextResponse: {
      json: jsonResponse,
      redirect: (url, status = 302) => redirectResponse(url, status),
    },
  };
}

function makeRequest({ url = "https://app/x", headers = {}, method = "GET" } = {}) {
  const headerStore = new Headers(headers);
  return {
    method,
    url,
    nextUrl: new URL(url),
    headers: headerStore,
    cookies: { get: () => undefined },
    async json() {
      return {};
    },
  };
}

function createFakePrisma(seed = {}) {
  const business = seed.business ?? {
    id: "biz1",
    userId: "user1",
  };
  const state = {
    business,
    mpConnections: new Map(seed.connections ?? []),
    oauthStates: new Map(),
    idempotencyRecords: new Map(),
    criticalWriteEvents: [],
  };

  const prisma = {
    state,
    $transaction: async (fnOrArr) => {
      if (typeof fnOrArr === "function") return fnOrArr(prisma);
      return Promise.all(fnOrArr);
    },
    business: {
      findUnique: async ({ where, select }) => {
        const matchesId = where?.id !== undefined && where.id === business.id;
        const matchesUserId = where?.userId !== undefined && where.userId === business.userId;
        if (!matchesId && !matchesUserId) return null;
        if (!select) return { ...business };
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = business[k] ?? null;
        return out;
      },
    },
    mpConnection: {
      findUnique: async ({ where, select }) => {
        const row = state.mpConnections.get(where.businessId);
        if (!row) return null;
        if (!select) return { ...row };
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
        return out;
      },
      upsert: async ({ where, create, update }) => {
        const existing = state.mpConnections.get(where.businessId);
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }
        const row = { id: `mpc${state.mpConnections.size + 1}`, businessId: where.businessId, ...create };
        state.mpConnections.set(where.businessId, row);
        return { ...row };
      },
      delete: async ({ where }) => {
        const existed = state.mpConnections.get(where.businessId);
        if (!existed) {
          const err = new Error("not found");
          err.code = "P2025";
          throw err;
        }
        state.mpConnections.delete(where.businessId);
        return { ...existed };
      },
    },
    oAuthState: {
      create: async ({ data }) => {
        state.oauthStates.set(data.state, { ...data });
        return { ...data };
      },
      findUnique: async ({ where }) => {
        const r = state.oauthStates.get(where.state);
        return r ? { ...r } : null;
      },
      deleteMany: async ({ where }) => {
        let count = 0;
        if (where?.state) {
          if (state.oauthStates.delete(where.state)) count++;
        }
        return { count };
      },
    },
    idempotencyRecord: {
      findFirst: async ({ where }) => {
        const key = `${where?.businessId}|${where?.actionType}|${where?.idempotencyKey}`;
        const r = state.idempotencyRecords.get(key);
        return r ? { ...r } : null;
      },
      create: async ({ data }) => {
        const key = `${data.businessId}|${data.actionType}|${data.idempotencyKey}`;
        if (state.idempotencyRecords.has(key)) {
          const e = new Error("Unique constraint failed");
          e.code = "P2002";
          throw e;
        }
        state.idempotencyRecords.set(key, {
          ...data,
          responseStatus: null,
          responseBody: null,
          completedAt: null,
        });
        return { id: data.id };
      },
      update: async ({ where, data }) => {
        for (const [k, r] of state.idempotencyRecords.entries()) {
          if (r.id !== where?.id) continue;
          const next = { ...r, ...data };
          state.idempotencyRecords.set(k, next);
          return { ...next };
        }
        throw new Error("not found");
      },
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const [k, r] of state.idempotencyRecords.entries()) {
          if (where?.id !== undefined && r.id !== where.id) continue;
          if (where?.status !== undefined && r.status !== where.status) continue;
          if (
            where?.updatedAt?.lt !== undefined &&
            !(r.updatedAt && r.updatedAt < where.updatedAt.lt)
          ) {
            continue;
          }
          if (
            where?.completedAt?.lt !== undefined &&
            !(r.completedAt && r.completedAt < where.completedAt.lt)
          ) {
            continue;
          }
          state.idempotencyRecords.delete(k);
          count++;
        }
        return { count };
      },
    },
    criticalWriteEvent: {
      create: async ({ data }) => {
        state.criticalWriteEvents.push({ ...data });
        return { id: data.id };
      },
    },
    // consumeOAuthState uses prisma.$queryRaw as a tagged template literal for
    // the atomic DELETE … RETURNING pattern. The fake replicates the consume-once
    // semantic: find the state, delete it if not expired, return the businessId.
    $queryRaw: async (strings, ...values) => {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (sql.includes("OAuthState") && sql.includes("RETURNING")) {
        const stateValue = values[0];
        const row = state.oauthStates.get(stateValue);
        if (!row) return [];
        if (row.expiresAt && row.expiresAt <= new Date()) return [];
        state.oauthStates.delete(stateValue);
        return [{ businessId: row.businessId }];
      }
      return [];
    },
    $executeRawUnsafe: async () => 0,
  };
  return prisma;
}

function makeMocks(prisma, opts = {}) {
  return {
    "next/server": makeNextServerMock(),
    "@/lib/prisma": { prisma },
    "@/auth": {
      auth: async () => (opts.unauth ? null : { user: { id: "user1" } }),
      signIn: async () => {},
      signOut: async () => {},
      ensureBusinessPlaceholder: async () => {},
    },
  };
}

function loadRoute(routeRelativePath, mocks) {
  resetSourceModules();
  clearMockModules();
  for (const [request, exports] of Object.entries(mocks)) {
    setMockModule(request, exports);
  }
  return require(`../../${routeRelativePath}`);
}

function withMpEnv(env, fn) {
  const keys = ["MP_CLIENT_ID", "MP_CLIENT_SECRET", "MP_REDIRECT_URI", "MP_TOKEN_ENCRYPTION_KEY"];
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

// 32-byte base64-encoded key for AES-256-GCM. Only used in tests — never
// committed for production. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
const TEST_ENCRYPTION_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const CONFIGURED = {
  MP_CLIENT_ID: "client",
  MP_CLIENT_SECRET: "secret",
  MP_REDIRECT_URI: "https://app/api/integrations/mp/callback",
  MP_TOKEN_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
};

// ── /connect ──────────────────────────────────────────────────────────

test("connect: env vacías → 503 MP_NOT_CONFIGURED", async () => {
  await withMpEnv({}, async () => {
    const prisma = createFakePrisma();
    const route = loadRoute(
      "src/app/api/integrations/mp/connect/route.ts",
      makeMocks(prisma),
    );
    const res = await route.GET(makeRequest());
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, "MP_NOT_CONFIGURED");
  });
});

test("connect: configurado → 302 con state persistido", async () => {
  await withMpEnv(CONFIGURED, async () => {
    const prisma = createFakePrisma();
    const route = loadRoute(
      "src/app/api/integrations/mp/connect/route.ts",
      makeMocks(prisma),
    );
    const res = await route.GET(makeRequest());
    assert.equal(res.status, 302);
    const location = res.headers.get("location");
    assert.ok(location.startsWith("https://auth.mercadopago.com.ar/authorization?"));
    assert.match(location, /client_id=client/);
    assert.match(location, /state=/);
    assert.equal(prisma.state.oauthStates.size, 1);
  });
});

// ── /callback ─────────────────────────────────────────────────────────

test("callback: state inexistente → redirect mp=invalid", async () => {
  await withMpEnv(CONFIGURED, async () => {
    const prisma = createFakePrisma();
    const route = loadRoute(
      "src/app/api/integrations/mp/callback/route.ts",
      makeMocks(prisma),
    );
    const res = await route.GET(
      makeRequest({ url: "https://app/api/integrations/mp/callback?code=c&state=ghost" }),
    );
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location"), /mp=invalid/);
    assert.equal(prisma.state.mpConnections.size, 0);
  });
});

test("callback: happy path → upsert MpConnection + redirect mp=connected", async () => {
  await withMpEnv(CONFIGURED, async () => {
    const prisma = createFakePrisma();
    // Pre-popular un state válido como si /connect lo hubiese creado.
    prisma.state.oauthStates.set("st-good", {
      state: "st-good",
      businessId: "biz1",
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    });

    // Stub global fetch para el token exchange.
    const originalFetch = global.fetch;
    global.fetch = async () =>
      new Response(
        JSON.stringify({
          access_token: "tok",
          refresh_token: "rfr",
          public_key: "pub",
          live_mode: true,
          user_id: 42,
          expires_in: 3600,
          scope: "offline_access read",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    try {
      const route = loadRoute(
        "src/app/api/integrations/mp/callback/route.ts",
        makeMocks(prisma),
      );
      const res = await route.GET(
        makeRequest({
          url: "https://app/api/integrations/mp/callback?code=c&state=st-good",
        }),
      );
      assert.equal(res.status, 302);
      assert.match(res.headers.get("location"), /mp=connected/);
      assert.equal(prisma.state.mpConnections.size, 1);
      const row = prisma.state.mpConnections.get("biz1");
      assert.equal(row.mpUserId, "42");
      // accessToken/refreshToken plaintext columns were dropped in migration
      // 20260519350000 — only encrypted ciphertext columns exist now.
      assert.ok(row.accessTokenCiphertext, "accessTokenCiphertext must be set");
      assert.ok(row.refreshTokenCiphertext, "refreshTokenCiphertext must be set");
      assert.equal(row.liveMode, true);
      // State consumido (consume-once).
      assert.equal(prisma.state.oauthStates.size, 0);
    } finally {
      global.fetch = originalFetch;
    }
  });
});

// ── /disconnect ───────────────────────────────────────────────────────

test("disconnect: borra MpConnection + emite audit + idempotency", async () => {
  await withMpEnv(CONFIGURED, async () => {
    const prisma = createFakePrisma({
      connections: [
        [
          "biz1",
          {
            id: "mpc1",
            businessId: "biz1",
            mpUserId: "42",
            accessToken: "tok",
            refreshToken: "rfr",
            publicKey: null,
            scope: null,
            liveMode: false,
            expiresAt: new Date(Date.now() + 3600_000),
            connectedAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      ],
    });
    const route = loadRoute(
      "src/app/api/integrations/mp/disconnect/route.ts",
      makeMocks(prisma),
    );
    const req = makeRequest({
      method: "POST",
      headers: { "x-idempotency-key": "k1", "content-type": "application/json" },
    });
    const res = await route.POST(req);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mpUserId, "42");
    assert.equal(prisma.state.mpConnections.size, 0);
    assert.equal(prisma.state.criticalWriteEvents.length, 1);
    assert.equal(prisma.state.criticalWriteEvents[0].actionType, "mp_connection.disconnect");
  });
});

test("disconnect: replay con misma idempotencyKey no duplica audit", async () => {
  await withMpEnv(CONFIGURED, async () => {
    const prisma = createFakePrisma({
      connections: [
        [
          "biz1",
          {
            id: "mpc1",
            businessId: "biz1",
            mpUserId: "42",
            accessToken: "tok",
            refreshToken: "rfr",
            publicKey: null,
            scope: null,
            liveMode: false,
            expiresAt: new Date(Date.now() + 3600_000),
            connectedAt: new Date(),
            updatedAt: new Date(),
          },
        ],
      ],
    });
    const route = loadRoute(
      "src/app/api/integrations/mp/disconnect/route.ts",
      makeMocks(prisma),
    );
    const req1 = makeRequest({
      method: "POST",
      headers: { "x-idempotency-key": "k-replay", "content-type": "application/json" },
    });
    const req2 = makeRequest({
      method: "POST",
      headers: { "x-idempotency-key": "k-replay", "content-type": "application/json" },
    });
    const r1 = await route.POST(req1);
    const r2 = await route.POST(req2);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    // Solo un audit aunque haya dos POST.
    assert.equal(prisma.state.criticalWriteEvents.length, 1);
  });
});
