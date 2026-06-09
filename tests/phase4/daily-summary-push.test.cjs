const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("./module-hooks.cjs");

// Reference moment: 20:00 AR on 2026-04-26 (cron fire time = 23:00 UTC).
const NOW_MS = Date.UTC(2026, 3, 26, 23, 0, 0, 0);

function arIso(year, month, day, hour, minute = 0) {
  // AR = UTC-3 → AR hour H = UTC hour H+3.
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute, 0, 0)).toISOString();
}

function makeBusiness(overrides = {}) {
  return {
    id: "biz1aaaaaaaaaaaaaaaaaaaa",
    name: "Ferretería Test",
    currency: "ARS",
    ...overrides,
  };
}

function makeMovement(overrides = {}) {
  return {
    id: "mv-1",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    type: "sale",
    amount: 1000,
    date: new Date(arIso(2026, 4, 26, 14)),
    description: "Venta",
    saleId: null,
    ...overrides,
  };
}

function makeSubscription(overrides = {}) {
  return {
    id: "sub-1",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    userId: "user1aaaaaaaaaaaaaaaaaaa",
    endpoint: "https://fcm.googleapis.com/abc",
    p256dh: "p",
    auth: "a",
    deviceLabel: null,
    expired: false,
    ...overrides,
  };
}

// In-memory Prisma fake covering only what the cron handler exercises.
function createCronPrisma({
  businesses = [makeBusiness()],
  movements = [makeMovement()],
  subscriptions = [makeSubscription()],
  preExistingLogs = [],
} = {}) {
  const state = {
    businesses: new Map(businesses.map((b) => [b.id, { ...b }])),
    movements: movements.map((m) => ({ ...m })),
    subscriptions: new Map(subscriptions.map((s) => [s.id, { ...s }])),
    logs: new Map(),
    criticalWriteEvents: [],
  };
  for (const log of preExistingLogs) {
    state.logs.set(`${log.businessId}|${log.dateAR}`, { ...log });
  }
  const calls = { logCreate: 0, logUpdate: 0, pushUpdate: 0 };

  const prisma = {
    state,
    calls,
    business: {
      findMany: async ({ where = {}, select } = {}) => {
        const ids = where.id?.in;
        const list = [...state.businesses.values()].filter((b) => {
          if (Array.isArray(ids)) return ids.includes(b.id);
          return true;
        });
        if (!select) return list;
        return list.map((b) => {
          const out = {};
          if (select.id) out.id = b.id;
          if (select.name) out.name = b.name;
          if (select.currency) out.currency = b.currency;
          return out;
        });
      },
    },
    cashMovement: {
      groupBy: async ({ by, where = {} }) => {
        const grouped = new Map();
        for (const m of state.movements) {
          if (where.date?.gte && m.date < where.date.gte) continue;
          if (where.date?.lte && m.date > where.date.lte) continue;
          const key = m[by[0]];
          grouped.set(key, (grouped.get(key) ?? 0) + 1);
        }
        return [...grouped.keys()].map((k) => ({ [by[0]]: k }));
      },
      findMany: async ({ where = {}, select }) => {
        return state.movements
          .filter((m) => {
            if (where.businessId && m.businessId !== where.businessId) return false;
            if (where.date?.gte && m.date < where.date.gte) return false;
            if (where.date?.lte && m.date > where.date.lte) return false;
            return true;
          })
          .map((m) => {
            if (!select) return { ...m };
            const out = {};
            if (select.id) out.id = m.id;
            if (select.type) out.type = m.type;
            if (select.amount) out.amount = m.amount;
            if (select.date) out.date = m.date;
            if (select.description) out.description = m.description;
            if (select.saleId) out.saleId = m.saleId;
            return out;
          });
      },
    },
    pushSubscription: {
      findMany: async ({ where = {}, select } = {}) => {
        const list = [...state.subscriptions.values()].filter((s) => {
          if (where.businessId && s.businessId !== where.businessId) return false;
          if (where.expired === false && s.expired) return false;
          return true;
        });
        if (!select) return list;
        return list.map((s) => {
          const out = {};
          if (select.id) out.id = s.id;
          if (select.endpoint) out.endpoint = s.endpoint;
          if (select.p256dh) out.p256dh = s.p256dh;
          if (select.auth) out.auth = s.auth;
          return out;
        });
      },
      update: async ({ where, data }) => {
        calls.pushUpdate += 1;
        const sub = state.subscriptions.get(where.id);
        if (!sub) throw new Error("subscription not found");
        Object.assign(sub, data);
        return { ...sub };
      },
    },
    dailySummaryPushLog: {
      create: async ({ data, select }) => {
        calls.logCreate += 1;
        const key = `${data.businessId}|${data.dateAR}`;
        if (state.logs.has(key)) {
          const error = new Error("UNIQUE constraint failed");
          error.code = "P2002";
          throw error;
        }
        const id = `log-${state.logs.size + 1}`;
        const row = {
          id,
          businessId: data.businessId,
          dateAR: data.dateAR,
          status: data.status,
          sentAt: null,
          error: null,
          createdAt: new Date(),
        };
        state.logs.set(key, row);
        return select?.id ? { id } : { ...row };
      },
      update: async ({ where, data }) => {
        calls.logUpdate += 1;
        for (const log of state.logs.values()) {
          if (log.id !== where.id) continue;
          Object.assign(log, data);
          return { ...log };
        }
        throw new Error("log not found");
      },
    },
    criticalWriteEvent: {
      create: async ({ data }) => {
        state.criticalWriteEvents.push({ ...data, createdAt: data.createdAt ?? new Date() });
        return { id: data.id };
      },
      deleteMany: async () => ({ count: 0 }),
    },
    $executeRawUnsafe: async () => 1,
    $queryRawUnsafe: async () => [],
  };

  return prisma;
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function makeMocks(prisma, sendPushImpl) {
  return {
    "next/server": {
      NextRequest: class NextRequest {},
      NextResponse: { json: jsonResponse },
    },
    "@/lib/prisma": { prisma },
    "@/app/api/_lib/web-push": {
      sendPush: sendPushImpl,
    },
  };
}

function loadCron(mocks) {
  resetSourceModules();
  clearMockModules();
  for (const [request, exports] of Object.entries(mocks)) {
    setMockModule(request, exports);
  }
  return require(path.join(process.cwd(), "src/app/api/scheduled/daily-summary-push/route.ts"));
}

function makeAuthorizedReq() {
  return {
    headers: new Headers({ authorization: "Bearer test-secret" }),
  };
}

const ORIGINAL_NOW = Date.now;
function freezeNow(ms) {
  Date.now = () => ms;
}
function restoreNow() {
  Date.now = ORIGINAL_NOW;
}

test("daily-summary-push: 401 sin bearer correcto", async () => {
  process.env.CRON_SECRET = "test-secret";
  const prisma = createCronPrisma();
  const sentLog = [];
  const route = loadCron(makeMocks(prisma, async (sub, payload) => {
    sentLog.push({ endpoint: sub.endpoint, payload });
    return { ok: true, expired: false, statusCode: 201 };
  }));

  const res = await route.GET({ headers: new Headers({ authorization: "Bearer wrong" }) });
  assert.equal(res.status, 401);
  assert.equal(prisma.calls.logCreate, 0);
});

test("daily-summary-push: día con ventas envía push, registra audit y log status=sent", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createCronPrisma({
      movements: [
        makeMovement({ id: "mv-sale", type: "sale", amount: 5000, date: new Date(arIso(2026, 4, 26, 11)) }),
        makeMovement({ id: "mv-cost", type: "purchase", amount: -2000, date: new Date(arIso(2026, 4, 26, 13)) }),
      ],
    });
    const sent = [];
    const route = loadCron(makeMocks(prisma, async (sub, payload) => {
      sent.push({ endpoint: sub.endpoint, payload });
      return { ok: true, expired: false, statusCode: 201 };
    }));

    const res = await route.GET(makeAuthorizedReq());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.processed, 1);
    assert.equal(body.sent, 1);
    assert.equal(body.errors, 0);
    assert.equal(body.skipped, 0);

    assert.equal(sent.length, 1);
    // Message format: "Hoy cobraste <sales>, gastaste <expenses>. Neto: <net>."
    assert.match(sent[0].payload.body, /cobraste/);
    assert.match(sent[0].payload.body, /gastaste/);

    const log = [...prisma.state.logs.values()][0];
    assert.equal(log.status, "sent");
    assert.equal(log.dateAR, "2026-04-26");

    assert.equal(prisma.state.criticalWriteEvents.length, 1);
    assert.equal(prisma.state.criticalWriteEvents[0].actionType, "daily-summary.push.send");
  } finally {
    restoreNow();
  }
});

test("daily-summary-push: día con SOLO gastos (sin ventas) marca log no-op y NO envía push", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createCronPrisma({
      movements: [
        makeMovement({ id: "mv-tax", type: "tax", amount: -800, date: new Date(arIso(2026, 4, 26, 9)) }),
      ],
    });
    const sent = [];
    const route = loadCron(makeMocks(prisma, async (sub, payload) => {
      sent.push({ endpoint: sub.endpoint, payload });
      return { ok: true, expired: false, statusCode: 201 };
    }));

    const res = await route.GET(makeAuthorizedReq());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.noOps, 1);
    assert.equal(body.sent, 0);

    assert.equal(sent.length, 0);
    const log = [...prisma.state.logs.values()][0];
    assert.equal(log.status, "no-op");
    assert.equal(prisma.state.criticalWriteEvents.length, 0);
  } finally {
    restoreNow();
  }
});

test("daily-summary-push: replay con log pre-existente para hoy → skipped, no envía", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createCronPrisma({
      preExistingLogs: [{ businessId: "biz1aaaaaaaaaaaaaaaaaaaa", dateAR: "2026-04-26", status: "sent" }],
    });
    const sent = [];
    const route = loadCron(makeMocks(prisma, async (sub) => {
      sent.push(sub.endpoint);
      return { ok: true, expired: false, statusCode: 201 };
    }));

    const res = await route.GET(makeAuthorizedReq());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.skipped, 1);
    assert.equal(body.sent, 0);
    assert.equal(sent.length, 0);
  } finally {
    restoreNow();
  }
});

test("daily-summary-push: subscription con 410 (gone) se marca expired pero no rompe el batch", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createCronPrisma({
      subscriptions: [
        makeSubscription({ id: "sub-dead", endpoint: "https://fcm/dead" }),
        makeSubscription({ id: "sub-alive", endpoint: "https://fcm/alive" }),
      ],
    });
    const route = loadCron(makeMocks(prisma, async (sub) => {
      if (sub.endpoint === "https://fcm/dead") {
        return { ok: false, expired: true, statusCode: 410, error: "Gone" };
      }
      return { ok: true, expired: false, statusCode: 201 };
    }));

    const res = await route.GET(makeAuthorizedReq());
    const body = await res.json();
    assert.equal(body.sent, 1);
    assert.equal(body.expiredSubscriptions, 1);

    const dead = prisma.state.subscriptions.get("sub-dead");
    assert.equal(dead.expired, true);
    const alive = prisma.state.subscriptions.get("sub-alive");
    assert.equal(alive.expired, false);

    const log = [...prisma.state.logs.values()][0];
    assert.equal(log.status, "sent");
  } finally {
    restoreNow();
  }
});

test("daily-summary-push: business sin subscriptions → log no-op", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createCronPrisma({ subscriptions: [] });
    let pushCalls = 0;
    const route = loadCron(makeMocks(prisma, async () => {
      pushCalls += 1;
      return { ok: true, expired: false, statusCode: 201 };
    }));

    const res = await route.GET(makeAuthorizedReq());
    const body = await res.json();
    assert.equal(body.noOps, 1);
    assert.equal(body.sent, 0);
    assert.equal(pushCalls, 0);

    const log = [...prisma.state.logs.values()][0];
    assert.equal(log.status, "no-op");
    assert.equal(log.error, "no-active-subscriptions");
  } finally {
    restoreNow();
  }
});

test("daily-summary-push: TODAS las suscripciones fallan con 5xx → status=failed, errors++ , no audit", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createCronPrisma();
    const route = loadCron(makeMocks(prisma, async () => ({
      ok: false,
      expired: false,
      statusCode: 503,
      error: "Service Unavailable",
    })));

    const res = await route.GET(makeAuthorizedReq());
    const body = await res.json();
    assert.equal(body.errors, 1);
    assert.equal(body.sent, 0);

    const log = [...prisma.state.logs.values()][0];
    assert.equal(log.status, "failed");
    assert.match(log.error, /Service Unavailable/);
    // No audit emitido en falla — el audit es prueba de envío exitoso.
    assert.equal(prisma.state.criticalWriteEvents.length, 0);
  } finally {
    restoreNow();
  }
});

test("daily-summary-push: ningún business con movimientos → result vacío", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createCronPrisma({ movements: [] });
    const route = loadCron(makeMocks(prisma, async () => ({ ok: true, expired: false, statusCode: 201 })));

    const res = await route.GET(makeAuthorizedReq());
    const body = await res.json();
    assert.equal(body.processed, 0);
    assert.equal(body.sent, 0);
    assert.equal(body.skipped, 0);
    assert.equal(body.noOps, 0);
  } finally {
    restoreNow();
  }
});
