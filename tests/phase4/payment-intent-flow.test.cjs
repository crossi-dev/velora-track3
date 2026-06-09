// Integration test del módulo Cobro QR (slice 1).
//
// Cubre:
//   1. POST /api/payment-intents/create — happy path (201) + idempotency
//      replay (mismo X-Idempotency-Key → mismo response).
//   2. POST /api/payment-intents/confirm — happy path (200) + replay con
//      misma idempotencyKey → exactamente UN CashMovement.
//   3. Concurrencia: dos confirms en paralelo con mismo idempotencyKey →
//      una completa, la otra replaya o devuelve 409. NUNCA 2 cash
//      movements para el mismo paymentIntent.

const assert = require("node:assert/strict");
const test = require("node:test");

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

function makeNextServerMock() {
  return {
    NextRequest: class NextRequest {},
    NextResponse: { json: jsonResponse },
  };
}

function makeRequest(body, idempotencyKey) {
  return {
    headers: new Headers(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
    async json() {
      return body;
    },
  };
}

function createFakePrisma(seed = {}) {
  const business = seed.business ?? {
    id: "biz1aaaaaaaaaaaaaaaaaaaa",
    userId: "user1aaaaaaaaaaaaaaaaaaa",
    name: "Velora",
    currency: "ARS",
  };
  const sales = new Map((seed.sales ?? []).map((s) => [s.id, { ...s }]));
  const state = {
    business,
    sales,
    paymentIntents: new Map(),
    cashMovements: [],
    criticalWriteEvents: [],
    idempotencyRecords: new Map(),
    counters: { paymentIntent: 0, cashMovement: 0, criticalWrite: 0 },
  };

  const prisma = {
    state,
    $transaction: async (fnOrArr) => {
      if (typeof fnOrArr === "function") return fnOrArr(prisma);
      return Promise.all(fnOrArr);
    },
    business: {
      findUnique: async ({ where, select }) => {
        // Match either id-based (handler lookup) or userId-based (resolveActor).
        const matchesId = where?.id !== undefined && where.id === business.id;
        const matchesUserId = where?.userId !== undefined && where.userId === business.userId;
        if (!matchesId && !matchesUserId) return null;
        if (!select) return { ...business };
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = business[k] ?? null;
        return out;
      },
    },
    sale: {
      findUnique: async ({ where, select }) => {
        const sale = sales.get(where?.id);
        if (!sale) return null;
        if (!select) return { ...sale };
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = sale[k] ?? null;
        return out;
      },
      update: async ({ where, data }) => {
        const sale = sales.get(where?.id);
        if (!sale) throw new Error("sale not found");
        Object.assign(sale, data);
        return { ...sale };
      },
    },
    paymentIntent: {
      create: async ({ data, select }) => {
        const id = `pi${++state.counters.paymentIntent}aaaaaaaaaaaaaaaaaaa`.slice(0, 24);
        const row = {
          id,
          businessId: data.businessId,
          saleId: data.saleId ?? null,
          monto: data.monto,
          metodo: data.metodo,
          estado: data.estado ?? "pending",
          idempotencyKey: data.idempotencyKey,
          confirmedAt: null,
          confirmedByEmployeeId: null,
          // Slice 3 — expiresAt + 2 min anti-comprobante-falso. El use-case
          // lo provee, el fake solo lo persiste tal cual lo recibe.
          expiresAt: data.expiresAt ?? null,
          // Slice 5 — devolución cash V1.
          refundedAt: null,
          refundedByEmployeeId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.paymentIntents.set(id, row);
        if (!select) return { ...row };
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = row[k];
        return out;
      },
      findFirst: async ({ where, select }) => {
        for (const pi of state.paymentIntents.values()) {
          if (where?.id !== undefined && pi.id !== where.id) continue;
          if (where?.businessId !== undefined && pi.businessId !== where.businessId) continue;
          if (!select) return { ...pi };
          const out = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = pi[k];
          return out;
        }
        return null;
      },
      update: async ({ where, data }) => {
        const pi = state.paymentIntents.get(where?.id);
        if (!pi) throw new Error("paymentIntent not found");
        Object.assign(pi, data);
        pi.updatedAt = new Date();
        return { ...pi };
      },
    },
    cashMovement: {
      create: async ({ data }) => {
        const id = `cm${++state.counters.cashMovement}aaaaaaaaaaaaaaaaaaa`.slice(0, 24);
        const row = { id, ...data };
        state.cashMovements.push(row);
        return row;
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
        state.counters.criticalWrite++;
        return { id: data.id };
      },
    },
    // policy-evaluator.ts (called by refund route) needs these two models.
    // Return empty arrays so every action is allowed in test scope.
    businessRule: {
      findMany: async () => [],
    },
    delegationPolicy: {
      findMany: async () => [],
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
      auth: async () => ({ user: { id: opts.authUserId ?? "user1aaaaaaaaaaaaaaaaaaa" } }),
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

// ── Tests ───────────────────────────────────────────────────────────

test("payment-intents/create — happy path returns 201 con qrPlaceholderUrl", async () => {
  const prisma = createFakePrisma();
  const route = loadRoute("src/app/api/payment-intents/create/route.ts", makeMocks(prisma));
  const res = await route.POST(
    makeRequest({ monto: 5000, metodo: "qr_dynamic_fake" }, "key-create-1"),
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.estado, "pending");
  assert.equal(body.monto, 5000);
  assert.equal(body.metodo, "qr_dynamic_fake");
  assert.equal(body.qrPlaceholderUrl, "/static/qr-placeholder.svg");
  assert.ok(body.paymentIntentId);
  assert.equal(prisma.state.paymentIntents.size, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("payment-intents/create — replay con mismo idempotencyKey no crea segundo intent", async () => {
  const prisma = createFakePrisma();
  const route = loadRoute("src/app/api/payment-intents/create/route.ts", makeMocks(prisma));
  const body = { monto: 7500, metodo: "qr_dynamic_fake" };
  const r1 = await route.POST(makeRequest(body, "key-create-replay"));
  const r2 = await route.POST(makeRequest(body, "key-create-replay"));
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  const j1 = await r1.json();
  const j2 = await r2.json();
  assert.equal(j1.paymentIntentId, j2.paymentIntentId, "replay debe devolver el mismo intent");
  assert.equal(prisma.state.paymentIntents.size, 1, "replay no debe crear segundo intent");
});

test("payment-intents/create — falta X-Idempotency-Key → 400", async () => {
  const prisma = createFakePrisma();
  const route = loadRoute("src/app/api/payment-intents/create/route.ts", makeMocks(prisma));
  const res = await route.POST(makeRequest({ monto: 100, metodo: "qr_dynamic_fake" }, undefined));
  assert.equal(res.status, 400);
});

test("payment-intents/confirm — happy path: PaymentIntent → confirmed + 1 CashMovement", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const created = await createRoute.POST(
    makeRequest({ monto: 1200, metodo: "qr_dynamic_fake" }, "key-flow-create"),
  );
  const createdJson = await created.json();
  const paymentIntentId = createdJson.paymentIntentId;

  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const res = await confirmRoute.POST(
    makeRequest({ paymentIntentId }, "key-flow-confirm"),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.paymentIntentId, paymentIntentId);

  const intent = prisma.state.paymentIntents.get(paymentIntentId);
  assert.equal(intent.estado, "confirmed");
  assert.ok(intent.confirmedAt instanceof Date);
  assert.equal(prisma.state.cashMovements.length, 1);
  assert.equal(Number(prisma.state.cashMovements[0].amount), 1200);
  assert.equal(prisma.state.cashMovements[0].type, "income");
});

test("payment-intents/confirm — replay con mismo idempotencyKey no duplica CashMovement", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const created = await createRoute.POST(
    makeRequest({ monto: 800, metodo: "qr_dynamic_fake" }, "key-replay-create"),
  );
  const paymentIntentId = (await created.json()).paymentIntentId;

  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const r1 = await confirmRoute.POST(makeRequest({ paymentIntentId }, "key-replay-confirm"));
  const r2 = await confirmRoute.POST(makeRequest({ paymentIntentId }, "key-replay-confirm"));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(
    prisma.state.cashMovements.length,
    1,
    "replay nunca debe duplicar el movimiento de caja",
  );
});

test("payment-intents/confirm — segundo confirm con DISTINTO idempotencyKey → 409 already_confirmed", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const created = await createRoute.POST(
    makeRequest({ monto: 600, metodo: "qr_dynamic_fake" }, "key-double-create"),
  );
  const paymentIntentId = (await created.json()).paymentIntentId;

  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const r1 = await confirmRoute.POST(makeRequest({ paymentIntentId }, "key-double-confirm-1"));
  const r2 = await confirmRoute.POST(makeRequest({ paymentIntentId }, "key-double-confirm-2"));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 409);
  assert.equal(
    prisma.state.cashMovements.length,
    1,
    "el segundo confirm rechazado no debe registrar movimiento adicional",
  );
});

test("payment-intents/confirm — payment intent inexistente → 404", async () => {
  const prisma = createFakePrisma();
  const route = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const res = await route.POST(
    makeRequest({ paymentIntentId: "pi-doesnt-exist" }, "key-not-found"),
  );
  assert.equal(res.status, 404);
});

// ── Slice 2: alias_personal flow ────────────────────────────────────

test("payment-intents/create — metodo alias_personal: 201 + estado pending", async () => {
  const prisma = createFakePrisma();
  const route = loadRoute("src/app/api/payment-intents/create/route.ts", makeMocks(prisma));
  const res = await route.POST(
    makeRequest({ monto: 5000, metodo: "alias_personal" }, "key-alias-create"),
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.estado, "pending");
  assert.equal(body.monto, 5000);
  assert.equal(body.metodo, "alias_personal");
  assert.ok(body.paymentIntentId);
  const stored = prisma.state.paymentIntents.get(body.paymentIntentId);
  assert.equal(stored.metodo, "alias_personal");
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("payment-intents — alias_personal end-to-end: create → confirm → 1 CashMovement", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const created = await createRoute.POST(
    makeRequest({ monto: 3500, metodo: "alias_personal" }, "key-alias-flow-create"),
  );
  assert.equal(created.status, 201);
  const paymentIntentId = (await created.json()).paymentIntentId;

  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const res = await confirmRoute.POST(
    makeRequest({ paymentIntentId }, "key-alias-flow-confirm"),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  const intent = prisma.state.paymentIntents.get(paymentIntentId);
  assert.equal(intent.estado, "confirmed");
  assert.equal(intent.metodo, "alias_personal");
  assert.equal(prisma.state.cashMovements.length, 1);
  assert.equal(Number(prisma.state.cashMovements[0].amount), 3500);
  assert.equal(prisma.state.cashMovements[0].type, "income");
});

test("payment-intents/create — alias_personal replay con mismo idempotencyKey no duplica", async () => {
  const prisma = createFakePrisma();
  const route = loadRoute("src/app/api/payment-intents/create/route.ts", makeMocks(prisma));
  const body = { monto: 2200, metodo: "alias_personal" };
  const r1 = await route.POST(makeRequest(body, "key-alias-replay"));
  const r2 = await route.POST(makeRequest(body, "key-alias-replay"));
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  const j1 = await r1.json();
  const j2 = await r2.json();
  assert.equal(j1.paymentIntentId, j2.paymentIntentId);
  assert.equal(prisma.state.paymentIntents.size, 1);
});

// ── Slice 3: timeout 2 min anti-comprobante-falso ─────────────────

test("payment-intents/create — incluye expiresAt ISO en el response (createdAt + 2 min)", async () => {
  const prisma = createFakePrisma();
  const route = loadRoute("src/app/api/payment-intents/create/route.ts", makeMocks(prisma));
  const before = Date.now();
  const res = await route.POST(
    makeRequest({ monto: 1000, metodo: "qr_dynamic_fake" }, "key-expires-1"),
  );
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.ok(body.expiresAt, "expiresAt debe venir seteado");
  const expiresAtMs = Date.parse(body.expiresAt);
  // Se espera ~120s; damos margen [110s, 130s] para tolerar lentitud del runner.
  assert.ok(expiresAtMs - before >= 110_000, "expiresAt debe ser createdAt + ~2 min");
  assert.ok(expiresAtMs - before <= 130_000, "expiresAt no puede pasarse de 2 min con margen");
});

test("payment-intents/confirm — pending+expirado → 410 EXPIRED + transición a estado expired", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const created = await createRoute.POST(
    makeRequest({ monto: 999, metodo: "qr_dynamic_fake" }, "key-expired-create"),
  );
  assert.equal(created.status, 201);
  const paymentIntentId = (await created.json()).paymentIntentId;

  // Simulamos avance del reloj: backdate expiresAt a 1 ms en el pasado.
  const stored = prisma.state.paymentIntents.get(paymentIntentId);
  stored.expiresAt = new Date(Date.now() - 1);

  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const res = await confirmRoute.POST(
    makeRequest({ paymentIntentId }, "key-expired-confirm"),
  );
  assert.equal(res.status, 410, "expirado debe devolver 410 GONE");
  const body = await res.json();
  assert.equal(body.code, "EXPIRED");
  assert.match(body.message, /expirado/i);

  const intent = prisma.state.paymentIntents.get(paymentIntentId);
  assert.equal(intent.estado, "expired", "intent debe quedar en estado expired");
  assert.equal(intent.confirmedAt, null, "expirado nunca debe poblar confirmedAt");
  assert.equal(
    prisma.state.cashMovements.length,
    0,
    "expirado nunca debe crear cash movement",
  );
});

test("payment-intents/confirm — segundo confirm sobre intent ya expired → 410 idempotente", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const created = await createRoute.POST(
    makeRequest({ monto: 500, metodo: "alias_personal" }, "key-expired-twice-create"),
  );
  const paymentIntentId = (await created.json()).paymentIntentId;
  prisma.state.paymentIntents.get(paymentIntentId).expiresAt = new Date(Date.now() - 1);

  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const r1 = await confirmRoute.POST(makeRequest({ paymentIntentId }, "key-exp-twice-1"));
  const r2 = await confirmRoute.POST(makeRequest({ paymentIntentId }, "key-exp-twice-2"));
  assert.equal(r1.status, 410);
  assert.equal(r2.status, 410, "intent ya expired debe seguir respondiendo 410");
  assert.equal(prisma.state.cashMovements.length, 0);
});

// ── Slice 5: devolución cash V1 ─────────────────────────────────────

test("payment-intents/refund — happy path: confirmed → refunded + 1 CashMovement negativo", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const refundRoute = loadRoute(
    "src/app/api/payment-intents/refund/route.ts",
    makeMocks(prisma),
  );

  const created = await createRoute.POST(
    makeRequest({ monto: 1500, metodo: "qr_dynamic_fake" }, "key-refund-happy-create"),
  );
  const paymentIntentId = (await created.json()).paymentIntentId;
  await confirmRoute.POST(makeRequest({ paymentIntentId }, "key-refund-happy-confirm"));

  const res = await refundRoute.POST(makeRequest({ paymentIntentId }, "key-refund-happy-do"));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.paymentIntentId, paymentIntentId);
  assert.equal(body.monto, 1500);
  assert.ok(body.refundedAt);

  const intent = prisma.state.paymentIntents.get(paymentIntentId);
  assert.equal(intent.estado, "refunded");
  assert.ok(intent.refundedAt instanceof Date);
  // 1 income (confirm) + 1 refund negativo
  assert.equal(prisma.state.cashMovements.length, 2);
  const refundMovement = prisma.state.cashMovements[1];
  assert.equal(refundMovement.type, "refund");
  assert.equal(Number(refundMovement.amount), -1500);
});

test("payment-intents/refund — pending intent → 400 NOT_CONFIRMED (no refund)", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const refundRoute = loadRoute(
    "src/app/api/payment-intents/refund/route.ts",
    makeMocks(prisma),
  );

  const created = await createRoute.POST(
    makeRequest({ monto: 600, metodo: "qr_dynamic_fake" }, "key-refund-pending-create"),
  );
  const paymentIntentId = (await created.json()).paymentIntentId;

  const res = await refundRoute.POST(makeRequest({ paymentIntentId }, "key-refund-pending-do"));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "NOT_CONFIRMED");
  assert.match(body.message, /pending/);

  const intent = prisma.state.paymentIntents.get(paymentIntentId);
  assert.equal(intent.estado, "pending", "pending no debe transicionar a refunded");
  assert.equal(prisma.state.cashMovements.length, 0);
});

test("payment-intents/refund — replay con mismo idempotencyKey NO duplica CashMovement", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const refundRoute = loadRoute(
    "src/app/api/payment-intents/refund/route.ts",
    makeMocks(prisma),
  );

  const created = await createRoute.POST(
    makeRequest({ monto: 250, metodo: "qr_dynamic_fake" }, "key-refund-replay-create"),
  );
  const paymentIntentId = (await created.json()).paymentIntentId;
  await confirmRoute.POST(makeRequest({ paymentIntentId }, "key-refund-replay-confirm"));

  const r1 = await refundRoute.POST(makeRequest({ paymentIntentId }, "key-refund-replay-do"));
  const r2 = await refundRoute.POST(makeRequest({ paymentIntentId }, "key-refund-replay-do"));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200, "replay debe devolver el response cacheado del primero");

  // 1 income (confirm) + 1 refund negativo. Replay NO duplica.
  assert.equal(prisma.state.cashMovements.length, 2);
  const refundMovements = prisma.state.cashMovements.filter((m) => m.type === "refund");
  assert.equal(refundMovements.length, 1, "replay nunca duplica el refund cash movement");
});

test("payment-intents/refund — segundo refund con DISTINTO idempotencyKey sobre ya refunded → 400", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const refundRoute = loadRoute(
    "src/app/api/payment-intents/refund/route.ts",
    makeMocks(prisma),
  );

  const created = await createRoute.POST(
    makeRequest({ monto: 700, metodo: "qr_dynamic_fake" }, "key-refund-twice-create"),
  );
  const paymentIntentId = (await created.json()).paymentIntentId;
  await confirmRoute.POST(makeRequest({ paymentIntentId }, "key-refund-twice-confirm"));

  const r1 = await refundRoute.POST(makeRequest({ paymentIntentId }, "key-refund-twice-1"));
  const r2 = await refundRoute.POST(makeRequest({ paymentIntentId }, "key-refund-twice-2"));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 400, "intent ya refunded no se puede refundear de nuevo");
  const body = await r2.json();
  assert.equal(body.code, "NOT_CONFIRMED");
  assert.match(body.message, /refunded/);

  const refundMovements = prisma.state.cashMovements.filter((m) => m.type === "refund");
  assert.equal(refundMovements.length, 1, "el segundo refund rechazado no debe registrar movimiento adicional");
});

test("payment-intents/refund — payment intent inexistente → 404", async () => {
  const prisma = createFakePrisma();
  const route = loadRoute(
    "src/app/api/payment-intents/refund/route.ts",
    makeMocks(prisma),
  );
  const res = await route.POST(
    makeRequest({ paymentIntentId: "pi-doesnt-exist" }, "key-refund-not-found"),
  );
  assert.equal(res.status, 404);
});

// ── Slice 6: offline-queue replay safety ────────────────────────────
//
// Las tres rutas del cobro QR (create/confirm/refund) NO se enrolan en
// el offline-queue de localStorage (`velora.offline-queue.v1`):
//
//   1. `payment_intent.create` corre in-process desde el chat handler,
//      no via `executeDashboardAction` — ese es el único punto donde se
//      consulta `tryQueueOfflineAction`.
//   2. `confirm`/`refund` son button clicks sobre cards que solo existen
//      tras un turno online exitoso. La 2-min expiry (slice 3) hace que
//      encolar offline sea anti-utilidad (el server respondería 410).
//
// La garantía de replay safety que provee el offline-queue se cumple
// aquí via `beginIdempotentMutation` server-side: si la red corta
// mid-confirm, el browser reintentará con el MISMO X-Idempotency-Key
// (porque `getOrCreateMutationKey` está keyed por signature estable),
// y el server devuelve el body cacheado del primer attempt en lugar de
// duplicar la mutación. Estos tests verifican ese contrato explícitamente.

test("slice 6 — replay create: retorna el mismo body cacheado, no duplica", async () => {
  const prisma = createFakePrisma();
  const route = loadRoute("src/app/api/payment-intents/create/route.ts", makeMocks(prisma));
  const body = { monto: 9000, metodo: "qr_dynamic_fake" };
  const r1 = await route.POST(makeRequest(body, "slice6-create-replay"));
  const r2 = await route.POST(makeRequest(body, "slice6-create-replay"));
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201);
  const j1 = await r1.json();
  const j2 = await r2.json();
  assert.equal(j2.paymentIntentId, j1.paymentIntentId);
  assert.equal(j2.estado, j1.estado);
  assert.equal(j2.monto, j1.monto);
  assert.equal(j2.qrPlaceholderUrl, j1.qrPlaceholderUrl);
  assert.equal(prisma.state.paymentIntents.size, 1);
  // criticalWriteEvent también es de un solo escribir (no se replica en replay).
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("slice 6 — replay confirm: no-op idempotente, mismo paymentIntentId, una sola CashMovement", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const created = await createRoute.POST(
    makeRequest({ monto: 4200, metodo: "qr_dynamic_fake" }, "slice6-confirm-create"),
  );
  const paymentIntentId = (await created.json()).paymentIntentId;

  const r1 = await confirmRoute.POST(makeRequest({ paymentIntentId }, "slice6-confirm-replay"));
  const r2 = await confirmRoute.POST(makeRequest({ paymentIntentId }, "slice6-confirm-replay"));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const j1 = await r1.json();
  const j2 = await r2.json();
  assert.equal(j2.ok, true);
  assert.equal(j2.paymentIntentId, j1.paymentIntentId);
  assert.equal(j2.saleId, j1.saleId);
  // El intent quedó confirmed una sola vez.
  assert.equal(prisma.state.paymentIntents.get(paymentIntentId).estado, "confirmed");
  // Cero duplicados.
  assert.equal(prisma.state.cashMovements.length, 1);
  assert.equal(prisma.state.criticalWriteEvents.filter((e) => e.actionType === "payment_intent.confirm").length, 1);
});

test("slice 6 — replay refund: no-op idempotente, una sola CashMovement negativa", async () => {
  const prisma = createFakePrisma();
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const refundRoute = loadRoute(
    "src/app/api/payment-intents/refund/route.ts",
    makeMocks(prisma),
  );

  const created = await createRoute.POST(
    makeRequest({ monto: 1800, metodo: "qr_dynamic_fake" }, "slice6-refund-create"),
  );
  const paymentIntentId = (await created.json()).paymentIntentId;
  await confirmRoute.POST(makeRequest({ paymentIntentId }, "slice6-refund-confirm"));

  const r1 = await refundRoute.POST(makeRequest({ paymentIntentId }, "slice6-refund-replay"));
  const r2 = await refundRoute.POST(makeRequest({ paymentIntentId }, "slice6-refund-replay"));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const j1 = await r1.json();
  const j2 = await r2.json();
  assert.equal(j2.ok, true);
  assert.equal(j2.paymentIntentId, j1.paymentIntentId);
  assert.equal(j2.monto, j1.monto);
  assert.equal(j2.refundedAt, j1.refundedAt, "replay debe devolver el mismo refundedAt cacheado");

  const intent = prisma.state.paymentIntents.get(paymentIntentId);
  assert.equal(intent.estado, "refunded");
  // 1 income (confirm) + 1 refund negativo. Replay del refund NO suma una segunda.
  const refundMovements = prisma.state.cashMovements.filter((m) => m.type === "refund");
  assert.equal(refundMovements.length, 1);
  assert.equal(Number(refundMovements[0].amount), -1800);
  assert.equal(prisma.state.criticalWriteEvents.filter((e) => e.actionType === "payment_intent.refund").length, 1);
});
