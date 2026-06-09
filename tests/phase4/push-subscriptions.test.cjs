const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("./module-hooks.cjs");

// Minimal in-memory Prisma fake covering only what the subscribe handler
// touches: idempotencyRecord, criticalWriteEvent, pushSubscription, business.
// Kept small on purpose — the giant fake in critical-flow-idempotency.test.cjs
// would couple this suite to unrelated regressions.
function createMiniPrisma({ business = { id: "biz1aaaaaaaaaaaaaaaaaaaa", userId: "user1aaaaaaaaaaaaaaaaaaa" } } = {}) {
  const state = {
    business,
    idempotencyRecords: new Map(),
    criticalWriteEvents: [],
    pushSubscriptions: new Map(),
  };
  const calls = { upsertCalls: 0, criticalWriteEventCalls: 0 };

  const prisma = {
    state,
    calls,
    business: {
      findUnique: async ({ where }) => {
        if (where?.userId && where.userId !== business.userId) return null;
        if (where?.id && where.id !== business.id) return null;
        return { ...business };
      },
    },
    idempotencyRecord: {
      findFirst: async ({ where }) => {
        const key = `${where?.businessId}|${where?.actionType}|${where?.idempotencyKey}`;
        const record = state.idempotencyRecords.get(key);
        return record ? { ...record } : null;
      },
      create: async ({ data }) => {
        const key = `${data.businessId}|${data.actionType}|${data.idempotencyKey}`;
        if (state.idempotencyRecords.has(key)) {
          const error = new Error("Unique constraint failed");
          error.code = "P2002";
          throw error;
        }
        state.idempotencyRecords.set(key, {
          id: data.id,
          businessId: data.businessId,
          actionType: data.actionType,
          idempotencyKey: data.idempotencyKey,
          requestHash: data.requestHash,
          status: data.status,
          responseStatus: null,
          responseBody: null,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
          completedAt: null,
        });
        return { id: data.id };
      },
      update: async ({ where, data }) => {
        for (const [key, record] of state.idempotencyRecords.entries()) {
          if (record.id !== where?.id) continue;
          const next = { ...record, ...data };
          state.idempotencyRecords.set(key, next);
          return { ...next };
        }
        throw new Error("IdempotencyRecord not found");
      },
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const [key, record] of state.idempotencyRecords.entries()) {
          if (where?.id !== undefined && record.id !== where.id) continue;
          if (where?.status !== undefined && record.status !== where.status) continue;
          if (where?.updatedAt?.lt !== undefined) {
            if (!record.updatedAt || record.updatedAt >= where.updatedAt.lt) continue;
          }
          if (where?.completedAt?.lt !== undefined) {
            if (!record.completedAt || record.completedAt >= where.completedAt.lt) continue;
          }
          state.idempotencyRecords.delete(key);
          count += 1;
        }
        return { count };
      },
    },
    criticalWriteEvent: {
      create: async ({ data }) => {
        calls.criticalWriteEventCalls += 1;
        state.criticalWriteEvents.push({
          ...data,
          createdAt: data.createdAt ?? new Date(),
        });
        return { id: data.id };
      },
    },
    pushSubscription: {
      upsert: async ({ where, update, create }) => {
        calls.upsertCalls += 1;
        const compositeKey = where?.businessId_endpoint;
        const stateKey = `${compositeKey?.businessId}|${compositeKey?.endpoint}`;
        const existing = state.pushSubscriptions.get(stateKey);
        if (existing) {
          const next = { ...existing, ...update };
          state.pushSubscriptions.set(stateKey, next);
          return { ...next };
        }
        const created = {
          id: `sub-${state.pushSubscriptions.size + 1}`,
          businessId: create.businessId,
          userId: create.userId,
          endpoint: create.endpoint,
          p256dh: create.p256dh,
          auth: create.auth,
          deviceLabel: create.deviceLabel ?? null,
          expired: false,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.pushSubscriptions.set(stateKey, created);
        return { ...created };
      },
    },
    $executeRawUnsafe: async (sql, ...params) => {
      const text = String(sql);
      if (text.startsWith("INSERT INTO IdempotencyRecord")) {
        const [id, businessId, actionType, idempotencyKey, requestHash, , createdAt, updatedAt] = params;
        const key = `${businessId}|${actionType}|${idempotencyKey}`;
        if (state.idempotencyRecords.has(key)) {
          const error = new Error("UNIQUE constraint failed");
          throw error;
        }
        state.idempotencyRecords.set(key, {
          id,
          businessId,
          actionType,
          idempotencyKey,
          requestHash,
          status: "pending",
          responseStatus: null,
          responseBody: null,
          createdAt,
          updatedAt,
          completedAt: null,
        });
        return 1;
      }
      if (text.startsWith("UPDATE IdempotencyRecord")) {
        const [responseStatus, responseBody, completedAt, updatedAt, id] = params;
        for (const record of state.idempotencyRecords.values()) {
          if (record.id === id) {
            record.status = "completed";
            record.responseStatus = responseStatus;
            record.responseBody = responseBody;
            record.completedAt = completedAt;
            record.updatedAt = updatedAt;
          }
        }
        return 1;
      }
      if (text.startsWith("DELETE FROM IdempotencyRecord")) {
        const [id] = params;
        for (const [key, record] of state.idempotencyRecords.entries()) {
          if (record.id === id && record.status === "pending") {
            state.idempotencyRecords.delete(key);
          }
        }
        return 1;
      }
      if (text.startsWith("INSERT INTO CriticalWriteEvent")) {
        return 1;
      }
      return 1;
    },
    $queryRawUnsafe: async () => [],
    $transaction: async (cb) => cb(prisma),
  };

  return prisma;
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function makeMocks(prisma) {
  return {
    "next/server": {
      NextRequest: class NextRequest {},
      NextResponse: { json: jsonResponse },
    },
    "@/lib/prisma": { prisma },
    "@/auth": {
      auth: async () => ({ user: { id: "user1aaaaaaaaaaaaaaaaaaa" } }),
      signIn: async () => {},
      signOut: async () => {},
    },
  };
}

function loadRoute(routeRelativePath, mocks) {
  resetSourceModules();
  clearMockModules();
  for (const [request, exports] of Object.entries(mocks)) {
    setMockModule(request, exports);
  }
  return require(path.join(process.cwd(), routeRelativePath));
}

function makeRequest(body, idempotencyKey) {
  return {
    headers: new Headers(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
    async json() {
      return body;
    },
  };
}

const ROUTE_PATH = "src/app/api/push-notifications/subscribe/route.ts";

test("push subscribe: persiste suscripción nueva con audit trace", async () => {
  const prisma = createMiniPrisma();
  const route = loadRoute(ROUTE_PATH, makeMocks(prisma));

  const res = await route.POST(
    makeRequest(
      {
        endpoint: "https://fcm.googleapis.com/abc",
        keys: { p256dh: "p256-key", auth: "auth-key" },
        deviceLabel: "Chrome Pixel",
      },
      "sub-key-1",
    ),
  );

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.deepEqual(json, { ok: true });
  assert.equal(prisma.calls.upsertCalls, 1);
  assert.equal(prisma.state.pushSubscriptions.size, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  const event = prisma.state.criticalWriteEvents[0];
  assert.equal(event.actionType, "push-notifications.subscribe");
  assert.equal(event.routeScope, "push-notifications/subscribe");
});

test("push subscribe: replay con misma idempotency-key no duplica filas ni audit", async () => {
  const prisma = createMiniPrisma();
  const route = loadRoute(ROUTE_PATH, makeMocks(prisma));
  const body = {
    endpoint: "https://fcm.googleapis.com/xyz",
    keys: { p256dh: "p", auth: "a" },
  };

  const first = await route.POST(makeRequest(body, "replay-key"));
  assert.equal(first.status, 200);

  const second = await route.POST(makeRequest(body, "replay-key"));
  assert.equal(second.status, 200);
  const secondJson = await second.json();
  assert.deepEqual(secondJson, { ok: true });

  // Replay debe servir desde el cache idempotente — sin tocar pushSubscription
  // ni emitir un segundo audit trace.
  assert.equal(prisma.calls.upsertCalls, 1);
  assert.equal(prisma.state.pushSubscriptions.size, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("push subscribe: re-suscripción del mismo endpoint refresca p256dh/auth y resetea expired", async () => {
  const prisma = createMiniPrisma();
  prisma.state.pushSubscriptions.set("biz1aaaaaaaaaaaaaaaaaaaa|https://fcm/old", {
    id: "sub-old",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    userId: "user1aaaaaaaaaaaaaaaaaaa",
    endpoint: "https://fcm/old",
    p256dh: "old-p",
    auth: "old-a",
    deviceLabel: "Old",
    expired: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const route = loadRoute(ROUTE_PATH, makeMocks(prisma));

  const res = await route.POST(
    makeRequest(
      {
        endpoint: "https://fcm/old",
        keys: { p256dh: "new-p", auth: "new-a" },
        deviceLabel: "Refreshed",
      },
      "renew-key",
    ),
  );
  assert.equal(res.status, 200);

  const refreshed = prisma.state.pushSubscriptions.get("biz1aaaaaaaaaaaaaaaaaaaa|https://fcm/old");
  assert.equal(refreshed.p256dh, "new-p");
  assert.equal(refreshed.auth, "new-a");
  assert.equal(refreshed.expired, false);
  // Sigue siendo una sola fila — el upsert no creó duplicado
  assert.equal(prisma.state.pushSubscriptions.size, 1);
});

test("push subscribe: payload sin endpoint devuelve 400 sin tocar la base", async () => {
  const prisma = createMiniPrisma();
  const route = loadRoute(ROUTE_PATH, makeMocks(prisma));

  const res = await route.POST(
    makeRequest({ keys: { p256dh: "p", auth: "a" } }, "bad-1"),
  );
  assert.equal(res.status, 400);
  assert.equal(prisma.state.pushSubscriptions.size, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("push subscribe: payload sin keys devuelve 400", async () => {
  const prisma = createMiniPrisma();
  const route = loadRoute(ROUTE_PATH, makeMocks(prisma));

  const res = await route.POST(
    makeRequest({ endpoint: "https://fcm/x" }, "bad-2"),
  );
  assert.equal(res.status, 400);
  assert.equal(prisma.state.pushSubscriptions.size, 0);
});

test("push subscribe: keys con p256dh vacío devuelve 400", async () => {
  const prisma = createMiniPrisma();
  const route = loadRoute(ROUTE_PATH, makeMocks(prisma));

  const res = await route.POST(
    makeRequest({ endpoint: "https://fcm/x", keys: { p256dh: "   ", auth: "a" } }, "bad-3"),
  );
  assert.equal(res.status, 400);
  assert.equal(prisma.state.pushSubscriptions.size, 0);
});
