// Tests for the cancel path of PaymentIntent (cobro QR).
//
// Covers:
//   1. POST /api/payment-intents/cancel — happy path: pending → cancelled (200).
//   2. Double-cancel with same idempotencyKey → idempotency replay (same 200, no second DB write).
//   3. Cancel after confirm → 409 NOT_CANCELLABLE (only pending → cancelled allowed).

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
  const state = {
    business,
    paymentIntents: new Map(
      (seed.paymentIntents ?? []).map((pi) => [pi.id, { ...pi }]),
    ),
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
        const matchesId = where?.id !== undefined && where.id === business.id;
        const matchesUserId = where?.userId !== undefined && where.userId === business.userId;
        if (!matchesId && !matchesUserId) return null;
        if (!select) return { ...business };
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = business[k] ?? null;
        return out;
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
          expiresAt: data.expiresAt ?? null,
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

// Helper: create a pending intent and return its id.
async function seedPendingIntent(prisma, monto = 3000) {
  const createRoute = loadRoute(
    "src/app/api/payment-intents/create/route.ts",
    makeMocks(prisma),
  );
  const res = await createRoute.POST(
    makeRequest({ monto, metodo: "qr_dynamic_fake" }, `key-seed-${Date.now()}`),
  );
  const body = await res.json();
  return body.paymentIntentId;
}

// ── Tests ───────────────────────────────────────────────────────────

test("payment-intents/cancel — happy path: pending → cancelled (200)", async () => {
  const prisma = createFakePrisma();
  const paymentIntentId = await seedPendingIntent(prisma, 2500);

  const cancelRoute = loadRoute(
    "src/app/api/payment-intents/cancel/route.ts",
    makeMocks(prisma),
  );
  const res = await cancelRoute.POST(
    makeRequest({ paymentIntentId }, "key-cancel-happy"),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.paymentIntentId, paymentIntentId);

  const intent = prisma.state.paymentIntents.get(paymentIntentId);
  assert.equal(intent.estado, "cancelled");
  // Cancel does not create a CashMovement (nothing was collected).
  assert.equal(prisma.state.cashMovements.length, 0);
  // Critical write event must be recorded.
  assert.equal(prisma.state.criticalWriteEvents.length, 2, "create + cancel = 2 audit events");
});

test("payment-intents/cancel — double-cancel with same idempotencyKey is idempotent", async () => {
  const prisma = createFakePrisma();
  const paymentIntentId = await seedPendingIntent(prisma, 1500);

  const cancelRoute = loadRoute(
    "src/app/api/payment-intents/cancel/route.ts",
    makeMocks(prisma),
  );
  const r1 = await cancelRoute.POST(makeRequest({ paymentIntentId }, "key-cancel-idem"));
  const r2 = await cancelRoute.POST(makeRequest({ paymentIntentId }, "key-cancel-idem"));

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200, "replay must return 200 (not error)");

  const j1 = await r1.json();
  const j2 = await r2.json();
  assert.equal(j1.paymentIntentId, j2.paymentIntentId, "replay must return same paymentIntentId");

  // Only one audit event for the cancel (plus one for create).
  assert.equal(prisma.state.criticalWriteEvents.length, 2);
});

test("payment-intents/cancel — cancel after confirm returns 409 NOT_CANCELLABLE", async () => {
  const prisma = createFakePrisma();
  const paymentIntentId = await seedPendingIntent(prisma, 4000);

  // First confirm the intent.
  const confirmRoute = loadRoute(
    "src/app/api/payment-intents/confirm/route.ts",
    makeMocks(prisma),
  );
  const confirmRes = await confirmRoute.POST(
    makeRequest({ paymentIntentId }, "key-confirm-before-cancel"),
  );
  assert.equal(confirmRes.status, 200, "confirm must succeed first");

  // Now try to cancel — must be rejected.
  const cancelRoute = loadRoute(
    "src/app/api/payment-intents/cancel/route.ts",
    makeMocks(prisma),
  );
  const cancelRes = await cancelRoute.POST(
    makeRequest({ paymentIntentId }, "key-cancel-after-confirm"),
  );
  assert.equal(cancelRes.status, 409);
  const body = await cancelRes.json();
  assert.equal(body.code, "NOT_CANCELLABLE");

  // The intent must still be "confirmed", not "cancelled".
  const intent = prisma.state.paymentIntents.get(paymentIntentId);
  assert.equal(intent.estado, "confirmed");
});
