const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("./module-hooks.cjs");

// Reference: 20:00 AR on 2026-04-26 = 23:00 UTC.
const NOW_MS = Date.UTC(2026, 3, 26, 23, 0, 0, 0);

function arIso(year, month, day, hour, minute = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour + 3, minute, 0, 0)).toISOString();
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

function createPrisma({
  businesses = [{ id: "biz1aaaaaaaaaaaaaaaaaaaa", currency: "ARS" }],
  movements = [makeMovement()],
  preExistingMessages = [],
} = {}) {
  const state = {
    businesses: new Map(businesses.map((b) => [b.id, { ...b }])),
    movements: movements.map((m) => ({ ...m })),
    chatMessages: [],
  };
  for (const msg of preExistingMessages) state.chatMessages.push({ ...msg });

  return {
    state,
    business: {
      findUnique: async ({ where, select }) => {
        const b = state.businesses.get(where.id);
        if (!b) return null;
        if (!select) return { ...b };
        const out = {};
        if (select.id) out.id = b.id;
        if (select.currency) out.currency = b.currency;
        return out;
      },
    },
    cashMovement: {
      groupBy: async ({ by, where = {} }) => {
        const grouped = new Map();
        for (const m of state.movements) {
          if (where.date?.gte && m.date < where.date.gte) continue;
          if (where.date?.lte && m.date > where.date.lte) continue;
          const key = m[by[0]];
          grouped.set(key, true);
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
            for (const k of Object.keys(select)) if (select[k]) out[k] = m[k];
            return out;
          });
      },
    },
    chatMessage: {
      findFirst: async ({ where = {}, select } = {}) => {
        const found = state.chatMessages.find(
          (m) =>
            (!where.businessId || m.businessId === where.businessId) &&
            (!where.clientMessageId || m.clientMessageId === where.clientMessageId),
        );
        if (!found) return null;
        if (!select) return { ...found };
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = found[k];
        return out;
      },
      findMany: async ({ where = {}, select, take } = {}) => {
        const startsWith = where.clientMessageId?.startsWith;
        const gteCreatedAt = where.createdAt?.gte;
        let rows = state.chatMessages.filter((m) => {
          if (where.businessId && m.businessId !== where.businessId) return false;
          if (startsWith && !(m.clientMessageId ?? "").startsWith(startsWith)) return false;
          if (gteCreatedAt && m.createdAt < gteCreatedAt) return false;
          return true;
        });
        if (typeof take === "number") rows = rows.slice(0, take);
        return rows.map((m) => {
          if (!select) return { ...m };
          const out = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = m[k];
          return out;
        });
      },
      create: async ({ data }) => {
        const exists = state.chatMessages.some(
          (m) => m.businessId === data.businessId && m.clientMessageId === data.clientMessageId,
        );
        if (exists) {
          const error = new Error("UNIQUE constraint");
          error.code = "P2002";
          throw error;
        }
        const row = {
          id: `cm-${state.chatMessages.length + 1}`,
          createdAt: new Date(),
          ...data,
        };
        state.chatMessages.push(row);
        return { ...row };
      },
    },
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function loadCron(prisma) {
  resetSourceModules();
  clearMockModules();
  setMockModule("next/server", {
    NextRequest: class NextRequest {},
    NextResponse: { json: jsonResponse },
  });
  setMockModule("@/lib/prisma", { prisma });
  return require(path.join(process.cwd(), "src/app/api/scheduled/daily-summary-chat/route.ts"));
}

function authReq() {
  return { headers: new Headers({ authorization: "Bearer test-secret" }) };
}

const ORIGINAL_NOW = Date.now;
function freezeNow(ms) {
  Date.now = () => ms;
}
function restoreNow() {
  Date.now = ORIGINAL_NOW;
}

test("daily-summary-chat: 401 sin bearer correcto", async () => {
  process.env.CRON_SECRET = "test-secret";
  const prisma = createPrisma();
  const route = loadCron(prisma);
  const res = await route.GET({ headers: new Headers({ authorization: "Bearer wrong" }) });
  assert.equal(res.status, 401);
  assert.equal(prisma.state.chatMessages.length, 0);
});

test("daily-summary-chat: día con ventas escribe ChatMessage con resumen", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createPrisma({
      movements: [
        makeMovement({ id: "mv-sale", type: "sale", amount: 5000, date: new Date(arIso(2026, 4, 26, 11)) }),
        makeMovement({ id: "mv-cost", type: "purchase", amount: -2000, date: new Date(arIso(2026, 4, 26, 13)) }),
      ],
    });
    const route = loadCron(prisma);
    const res = await route.GET(authReq());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.written, 1);
    assert.equal(body.skipped, 0);
    assert.equal(body.dateAR, "2026-04-26");

    assert.equal(prisma.state.chatMessages.length, 1);
    const msg = prisma.state.chatMessages[0];
    assert.equal(msg.businessId, "biz1aaaaaaaaaaaaaaaaaaaa");
    assert.equal(msg.clientMessageId, "daily-summary-biz1aaaaaaaaaaaaaaaaaaaa-2026-04-26");
    assert.equal(msg.source, "manager");
    assert.equal(msg.kind, "reply");
    assert.match(msg.text, /Resumen de hoy/);
    assert.match(msg.text, /vendiste/);
    assert.match(msg.text, /gastaste/);
    assert.match(msg.text, /te quedó/);
  } finally {
    restoreNow();
  }
});

test("daily-summary-chat: solo ventas (sin gastos) genera mensaje sin gastaste", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createPrisma({
      movements: [
        makeMovement({ id: "mv-sale", type: "sale", amount: 3000, date: new Date(arIso(2026, 4, 26, 10)) }),
      ],
    });
    const route = loadCron(prisma);
    await route.GET(authReq());
    const msg = prisma.state.chatMessages[0];
    assert.match(msg.text, /vendiste/);
    assert.doesNotMatch(msg.text, /gastaste/);
    assert.match(msg.text, /te quedó/);
  } finally {
    restoreNow();
  }
});

test("daily-summary-chat: día con SOLO gastos (sin ventas) skip — no escribe nada", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createPrisma({
      movements: [
        makeMovement({ id: "mv-tax", type: "tax", amount: -800, date: new Date(arIso(2026, 4, 26, 9)) }),
      ],
    });
    const route = loadCron(prisma);
    const res = await route.GET(authReq());
    const body = await res.json();
    assert.equal(body.written, 0);
    assert.equal(body.skipped, 1);
    assert.equal(prisma.state.chatMessages.length, 0);
  } finally {
    restoreNow();
  }
});

test("daily-summary-chat: día malo (gastos > ventas, net<0) escribe mensaje de alerta — no silencia", async () => {
  // Bible §4 revisada (commit post 2026-05-16): cuando hay ventas pero net<0,
  // el supervisor escribe un mensaje de alerta en lugar de silenciarse.
  // Solo se silencia cuando no hubo ventas en absoluto (sales=0).
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createPrisma({
      movements: [
        makeMovement({ id: "mv-sale", type: "sale", amount: 200, date: new Date(arIso(2026, 4, 26, 10)) }),
        makeMovement({ id: "mv-tax", type: "tax", amount: -500, date: new Date(arIso(2026, 4, 26, 11)) }),
      ],
    });
    const route = loadCron(prisma);
    const res = await route.GET(authReq());
    const body = await res.json();
    // Net < 0 but sales > 0 → alert message written (not silenced)
    assert.equal(body.written, 1);
    assert.equal(body.skipped, 0);
    assert.equal(prisma.state.chatMessages.length, 1);
    assert.match(prisma.state.chatMessages[0].text, /negativo/);
  } finally {
    restoreNow();
  }
});

test("daily-summary-chat: replay con mensaje ya escrito hoy — skip, no duplica", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createPrisma({
      preExistingMessages: [
        {
          id: "cmoldaaaaaaaaaaaaaaaaaaa",
          businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
          clientMessageId: "daily-summary-biz1aaaaaaaaaaaaaaaaaaaa-2026-04-26",
          kind: "reply",
          source: "manager",
          text: "Resumen previo",
        },
      ],
    });
    const route = loadCron(prisma);
    const res = await route.GET(authReq());
    const body = await res.json();
    assert.equal(body.written, 0);
    assert.equal(body.skipped, 1);
    // Sigue habiendo solo el mensaje original
    assert.equal(prisma.state.chatMessages.length, 1);
    assert.equal(prisma.state.chatMessages[0].text, "Resumen previo");
  } finally {
    restoreNow();
  }
});

test("daily-summary-chat: ningún business con movimientos hoy → result vacío", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createPrisma({ movements: [] });
    const route = loadCron(prisma);
    const res = await route.GET(authReq());
    const body = await res.json();
    assert.equal(body.written, 0);
    assert.equal(body.skipped, 0);
    assert.equal(prisma.state.chatMessages.length, 0);
  } finally {
    restoreNow();
  }
});

test("daily-summary-chat: errores por business aislados (no rompen el batch)", async () => {
  process.env.CRON_SECRET = "test-secret";
  freezeNow(NOW_MS);
  try {
    const prisma = createPrisma({
      businesses: [
        { id: "biz1aaaaaaaaaaaaaaaaaaaa", currency: "ARS" },
        { id: "biz2aaaaaaaaaaaaaaaaaaaa", currency: "ARS" },
      ],
      movements: [
        makeMovement({ id: "mv-1", businessId: "biz1aaaaaaaaaaaaaaaaaaaa", amount: 1000, date: new Date(arIso(2026, 4, 26, 10)) }),
        makeMovement({ id: "mv-2", businessId: "biz2aaaaaaaaaaaaaaaaaaaa", amount: 2000, date: new Date(arIso(2026, 4, 26, 11)) }),
      ],
    });
    // Hacemos que biz-1 falle al crear el ChatMessage, biz-2 debería seguir.
    const realCreate = prisma.chatMessage.create;
    prisma.chatMessage.create = async (args) => {
      if (args.data.businessId === "biz1aaaaaaaaaaaaaaaaaaaa") throw new Error("simulated DB failure");
      return realCreate(args);
    };
    const route = loadCron(prisma);
    const res = await route.GET(authReq());
    const body = await res.json();
    assert.equal(body.errors, 1);
    assert.equal(body.written, 1);
    assert.equal(prisma.state.chatMessages.length, 1);
    assert.equal(prisma.state.chatMessages[0].businessId, "biz2aaaaaaaaaaaaaaaaaaaa");
  } finally {
    restoreNow();
  }
});
