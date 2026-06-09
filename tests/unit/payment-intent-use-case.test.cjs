// Unit test del payment-intent use-case.
//
// Cubre las invariantes del slice 1 (cobro QR tracer) que el integration
// test ya valida end-to-end pero a nivel route handler. Acá nos enfocamos
// en el use-case puro:
//   1. Mismo idempotencyKey en create → mismo paymentIntentId (insert-first
//      atómico, P2002 readback).
//   2. Default `estado` es "pending" (el slice 1 NO auto-confirma).
//   3. Confirm de un intent pending → estado "confirmed", confirmedAt set,
//      confirmedByEmployeeId persistido.
//   4. Confirm con replay (mismo idempotencyKey) → mismo response, NO
//      duplica el CashMovement.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("../phase4/module-hooks.cjs");

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

function createFakePrisma() {
  const business = {
    id: "biz1aaaaaaaaaaaaaaaaaaaa",
    userId: "user1aaaaaaaaaaaaaaaaaaa",
    name: "Velora",
    currency: "ARS",
  };
  const state = {
    business,
    sales: new Map(),
    paymentIntents: new Map(),
    cashMovements: [],
    criticalWriteEvents: [],
    idempotencyRecords: new Map(),
    counters: { paymentIntent: 0, cashMovement: 0 },
  };

  const prisma = {
    state,
    $transaction: async (fnOrArr) => {
      if (typeof fnOrArr === "function") return fnOrArr(prisma);
      return Promise.all(fnOrArr);
    },
    business: {
      findUnique: async ({ where, select }) => {
        if (where?.id !== business.id && where?.userId !== business.userId) return null;
        if (!select) return { ...business };
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = business[k] ?? null;
        return out;
      },
    },
    sale: {
      findUnique: async () => null,
      update: async () => null,
    },
    paymentIntent: {
      create: async ({ data, select }) => {
        const id = `pi${++state.counters.paymentIntent}aaaaaaaaaaaaaaaaaaaa`.slice(0, 24);
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
          // Slice 3 — expiresAt timeout 2 min anti-comprobante-falso.
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
      // confirm-transaction.ts uses updateMany for the PI state transition
      // (WHERE estado IN ('pending','expired')) to avoid a read-modify-write race.
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const pi of state.paymentIntents.values()) {
          if (where?.id !== undefined && pi.id !== where.id) continue;
          if (where?.businessId !== undefined && pi.businessId !== where.businessId) continue;
          if (where?.estado?.in !== undefined && !where.estado.in.includes(pi.estado)) continue;
          Object.assign(pi, data);
          pi.updatedAt = new Date();
          count++;
        }
        return { count };
      },
    },
    cashMovement: {
      create: async ({ data }) => {
        const id = `cm${++state.counters.cashMovement}aaaaaaaaaaaaaaaaaaaa`.slice(0, 24);
        const row = { id, ...data };
        state.cashMovements.push(row);
        return row;
      },
      // Slice 3 — confirm-transaction.ts now uses createMany(skipDuplicates:true)
      // to close audit C-1 (mid-flight death gap) while remaining idempotent.
      // Mirrors Postgres INSERT ... ON CONFLICT DO NOTHING: duplicate clientMessageId
      // rows are silently skipped (count=0) without throwing P2002.
      // Ref: postgresql.org/docs/current/sql-insert.html
      createMany: async ({ data, skipDuplicates }) => {
        let count = 0;
        for (const item of data) {
          if (skipDuplicates && item.clientMessageId) {
            const exists = state.cashMovements.some(
              (m) =>
                m.businessId === item.businessId &&
                m.clientMessageId === item.clientMessageId,
            );
            if (exists) continue; // ON CONFLICT DO NOTHING
          }
          const id = `cm${++state.counters.cashMovement}aaaaaaaaaaaaaaaaaaaa`.slice(0, 24);
          state.cashMovements.push({ id, ...item });
          count++;
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
      deleteMany: async () => ({ count: 0 }),
    },
    criticalWriteEvent: {
      create: async ({ data }) => {
        state.criticalWriteEvents.push({ ...data });
        return { id: data.id };
      },
    },
    $executeRawUnsafe: async () => 0,
  };
  return prisma;
}

function loadUseCase(prisma) {
  resetSourceModules();
  clearMockModules();
  setMockModule("next/server", makeNextServerMock());
  setMockModule("@/lib/prisma", { prisma });
  return require("../../src/app/api/payment-intents/_lib/payment-intent-use-case.ts");
}

function loadRefundUseCase(prisma) {
  // Slice 5 — el refund use-case vive en sibling separado para preservar
  // el hard limit de 300 LOC del file principal.
  resetSourceModules();
  clearMockModules();
  setMockModule("next/server", makeNextServerMock());
  setMockModule("@/lib/prisma", { prisma });
  // Both modules need to share the same prisma — el create+confirm
  // del scenario corre primero y luego cargamos el refund.
  const useCase = require("../../src/app/api/payment-intents/_lib/payment-intent-use-case.ts");
  const refundUseCase = require("../../src/app/api/payment-intents/_lib/refund-use-case.ts");
  return { ...useCase, ...refundUseCase };
}

const BUSINESS_ID = "biz1aaaaaaaaaaaaaaaaaaaa";
const ACTOR_USER_ID = "user1aaaaaaaaaaaaaaaaaaa";

// ── Tests ───────────────────────────────────────────────────────────

test("createPaymentIntentUseCase — same idempotencyKey twice replays the same paymentIntentId", async () => {
  const prisma = createFakePrisma();
  const useCase = loadUseCase(prisma);

  const inputs = {
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 5000,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-same-twice",
  };

  const first = await useCase.createPaymentIntentUseCase(inputs);
  const second = await useCase.createPaymentIntentUseCase(inputs);

  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "replayed");
  assert.equal(prisma.state.paymentIntents.size, 1, "no debe crear un segundo PaymentIntent");

  const replayedBody = second.body;
  assert.equal(
    replayedBody.paymentIntentId,
    first.intent.paymentIntentId,
    "replay debe devolver el mismo paymentIntentId",
  );
});

test("createPaymentIntentUseCase — default estado is 'pending' (no auto-confirm en slice 1)", async () => {
  const prisma = createFakePrisma();
  const useCase = loadUseCase(prisma);

  const result = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 1234,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-pending",
  });

  assert.equal(result.outcome, "created");
  assert.equal(result.intent.estado, "pending");
  assert.equal(result.intent.qrPlaceholderUrl, "/static/qr-placeholder.svg");

  const stored = prisma.state.paymentIntents.get(result.intent.paymentIntentId);
  assert.equal(stored.estado, "pending");
  assert.equal(stored.confirmedAt, null);
  assert.equal(prisma.state.cashMovements.length, 0, "no debe haber CashMovement antes del confirm");
});

test("confirmPaymentIntentUseCase — pending → confirmed + confirmedAt + confirmedByEmployeeId", async () => {
  const prisma = createFakePrisma();
  const useCase = loadUseCase(prisma);

  const created = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 999,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-confirm-create",
  });
  assert.equal(created.outcome, "created");

  const confirmed = await useCase.confirmPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: "emp1aaaaaaaaaaaaaaaaaaaa",
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-confirm-confirm",
  });

  assert.equal(confirmed.outcome, "confirmed");
  assert.equal(confirmed.paymentIntentId, created.intent.paymentIntentId);

  const stored = prisma.state.paymentIntents.get(created.intent.paymentIntentId);
  assert.equal(stored.estado, "confirmed");
  assert.ok(stored.confirmedAt instanceof Date, "confirmedAt debe ser una Date");
  assert.equal(stored.confirmedByEmployeeId, "emp1aaaaaaaaaaaaaaaaaaaa");
  assert.equal(prisma.state.cashMovements.length, 1, "confirm crea exactamente 1 CashMovement");
  assert.equal(prisma.state.cashMovements[0].type, "income");
});

// ── Webhook confirm — metodo discrimination (regression: link payments) ──

test("confirmPaymentIntentUseCase — webhook confirm KEEPS checkout_pro_link metodo (no clobber)", async () => {
  const prisma = createFakePrisma();
  const useCase = loadUseCase(prisma);

  const created = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 3250,
    metodo: "checkout_pro_link",
    idempotencyKey: "key-link-webhook-create",
  });
  assert.equal(created.outcome, "created");

  // actorUserId "system-mp-webhook" → isWebhookConfirm = true.
  const confirmed = await useCase.confirmPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: "system-mp-webhook",
    actorEmployeeId: null,
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-link-webhook-confirm",
  });
  assert.equal(confirmed.outcome, "confirmed");

  const stored = prisma.state.paymentIntents.get(created.intent.paymentIntentId);
  // The bug: webhook confirm clobbered metodo → qr_dynamic_real, so post-confirm
  // routed link payments to camino A (customer text) instead of camino B
  // (comprobante + Andreani shipment + owner notice). metodo MUST stay.
  assert.equal(stored.metodo, "checkout_pro_link", "webhook confirm must NOT clobber a link payment's metodo");
});

test("confirmPaymentIntentUseCase — webhook confirm UPGRADES qr_dynamic_fake → qr_dynamic_real", async () => {
  const prisma = createFakePrisma();
  const useCase = loadUseCase(prisma);

  const created = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 1000,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-qr-webhook-create",
  });
  assert.equal(created.outcome, "created");

  const confirmed = await useCase.confirmPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: "system-mp-webhook",
    actorEmployeeId: null,
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-qr-webhook-confirm",
  });
  assert.equal(confirmed.outcome, "confirmed");

  const stored = prisma.state.paymentIntents.get(created.intent.paymentIntentId);
  // Preserved behavior: the QR placeholder is upgraded to the real method.
  assert.equal(stored.metodo, "qr_dynamic_real", "webhook confirm upgrades the QR placeholder to qr_dynamic_real");
});

// ── Slice 3: timeout 2 min anti-comprobante-falso ─────────────────

test("createPaymentIntentUseCase — expiresAt seteado a createdAt + 2 min (slice 3)", async () => {
  const prisma = createFakePrisma();
  const useCase = loadUseCase(prisma);

  const before = Date.now();
  const result = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 5000,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-expiry-create",
  });
  assert.equal(result.outcome, "created");
  assert.ok(result.intent.expiresAt, "expiresAt debe venir poblado");
  const expiresAtMs = Date.parse(result.intent.expiresAt);
  assert.ok(expiresAtMs - before >= 110_000, "expiresAt debe ser ~2 min en el futuro");
  assert.ok(expiresAtMs - before <= 130_000, "expiresAt no debe exceder 2 min con margen");

  const stored = prisma.state.paymentIntents.get(result.intent.paymentIntentId);
  assert.ok(stored.expiresAt instanceof Date, "expiresAt persistido como Date");
});

test("confirmPaymentIntentUseCase — pending+expirado → outcome 'expired' + estado 'expired' + sin CashMovement", async () => {
  const prisma = createFakePrisma();
  const useCase = loadUseCase(prisma);

  const created = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 750,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-expired-create-uc",
  });
  // Backdate expiresAt para simular avance del reloj > 2 min.
  prisma.state.paymentIntents.get(created.intent.paymentIntentId).expiresAt = new Date(
    Date.now() - 1,
  );

  const result = await useCase.confirmPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: "emp1aaaaaaaaaaaaaaaaaaaa",
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-expired-confirm-uc",
  });

  assert.equal(result.outcome, "expired");
  assert.equal(result.paymentIntentId, created.intent.paymentIntentId);

  const stored = prisma.state.paymentIntents.get(created.intent.paymentIntentId);
  assert.equal(stored.estado, "expired", "intent transiciona a estado expired (lazy)");
  assert.equal(stored.confirmedAt, null, "expirado nunca confirma");
  assert.equal(prisma.state.cashMovements.length, 0, "expirado no genera CashMovement");
});

test("confirmPaymentIntentUseCase — replay con mismo idempotencyKey NO duplica CashMovement", async () => {
  const prisma = createFakePrisma();
  const useCase = loadUseCase(prisma);

  const created = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 333,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-replay-create",
  });
  const paymentIntentId = created.intent.paymentIntentId;

  const first = await useCase.confirmPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    paymentIntentId,
    idempotencyKey: "key-replay-confirm",
  });
  const second = await useCase.confirmPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    paymentIntentId,
    idempotencyKey: "key-replay-confirm",
  });

  assert.equal(first.outcome, "confirmed");
  assert.equal(second.outcome, "replayed");
  assert.equal(
    prisma.state.cashMovements.length,
    1,
    "replay NUNCA debe duplicar el CashMovement",
  );
});

// ── Slice 5: devolución cash V1 ─────────────────────────────────────

test("refundPaymentIntentUseCase — confirmed → refunded + CashMovement negativo", async () => {
  const prisma = createFakePrisma();
  const useCase = loadRefundUseCase(prisma);

  const created = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 1500,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-refund-create",
  });
  await useCase.confirmPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-refund-confirm",
  });

  const result = await useCase.refundPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: "emp1aaaaaaaaaaaaaaaaaaaa",
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-refund-do",
  });

  assert.equal(result.outcome, "refunded");
  assert.equal(result.monto, 1500);
  assert.ok(result.refundedAt, "refundedAt debe venir poblado en el response");

  const stored = prisma.state.paymentIntents.get(created.intent.paymentIntentId);
  assert.equal(stored.estado, "refunded");
  assert.ok(stored.refundedAt instanceof Date, "refundedAt persistido como Date");
  assert.equal(stored.refundedByEmployeeId, "emp1aaaaaaaaaaaaaaaaaaaa");
  assert.equal(prisma.state.cashMovements.length, 2, "income del confirm + refund negativo");
  const refundMovement = prisma.state.cashMovements[1];
  assert.equal(refundMovement.type, "refund");
  assert.equal(Number(refundMovement.amount), -1500, "refund debe ser monto negativo");
});

test("refundPaymentIntentUseCase — pending intent → not_confirmed (no refund)", async () => {
  const prisma = createFakePrisma();
  const useCase = loadRefundUseCase(prisma);

  const created = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 800,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-refund-pending-create",
  });

  const result = await useCase.refundPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-refund-pending-do",
  });

  assert.equal(result.outcome, "not_confirmed");
  assert.equal(result.estado, "pending");

  const stored = prisma.state.paymentIntents.get(created.intent.paymentIntentId);
  assert.equal(stored.estado, "pending", "intent pending NO transiciona a refunded");
  assert.equal(stored.refundedAt, null);
  assert.equal(prisma.state.cashMovements.length, 0, "pending no genera ningún CashMovement");
});

test("refundPaymentIntentUseCase — replay (mismo idempotencyKey) NO duplica CashMovement", async () => {
  const prisma = createFakePrisma();
  const useCase = loadRefundUseCase(prisma);

  const created = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 444,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-refund-replay-create",
  });
  await useCase.confirmPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-refund-replay-confirm",
  });

  const first = await useCase.refundPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-refund-replay-do",
  });
  const second = await useCase.refundPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-refund-replay-do",
  });

  assert.equal(first.outcome, "refunded");
  assert.equal(second.outcome, "replayed");
  // 1 income (confirm) + 1 refund negativo. Replay NO duplica el refund.
  assert.equal(prisma.state.cashMovements.length, 2, "replay nunca duplica el CashMovement de refund");
  const refundMovements = prisma.state.cashMovements.filter((m) => m.type === "refund");
  assert.equal(refundMovements.length, 1);
});

// ── Slice 3 regression: atomic batch + idempotent cash insert ──────────────
//
// These two tests cover the failure modes closed by the SLICE 3 FIX (2026-06-07):
//
//   Test A — normal confirm writes PI + CashMovement atomically (in one batch).
//   Verifies that the all-or-nothing guarantee is honoured under the happy path.
//   (Failure mode B closed: mid-flight process death cannot leave PI confirmed
//   with CashMovement missing, because they are now ONE atomic Postgres transaction.)
//
//   Test B — duplicate CashMovement (same clientMessageId) does NOT roll back PI/Sale.
//   Verifies that createMany(skipDuplicates:true) = INSERT ... ON CONFLICT DO NOTHING:
//   the duplicate is silently skipped (cashResult.count=0), the batch commits,
//   and the outcome is still "confirmed".
//   (Failure mode A closed: the 2026-05-26 incident was P2002 rolling back the
//   PI update; with skipDuplicates the batch never raises P2002.)
//
// Ref: postgresql.org/docs/current/sql-insert.html (ON CONFLICT DO NOTHING)
//      brandur.org/idempotency-keys (atomic phase pattern)

test("slice3 — confirm writes PI+CashMovement atomically in ONE batch (happy path)", async () => {
  const prisma = createFakePrisma();
  const useCase = loadUseCase(prisma);

  const created = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 2000,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-slice3-atomic-create",
  });
  assert.equal(created.outcome, "created");

  const confirmed = await useCase.confirmPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: "emp1aaaaaaaaaaaaaaaaaaaa",
    paymentIntentId: created.intent.paymentIntentId,
    idempotencyKey: "key-slice3-atomic-confirm",
  });

  assert.equal(confirmed.outcome, "confirmed");

  const storedPi = prisma.state.paymentIntents.get(created.intent.paymentIntentId);
  assert.equal(storedPi.estado, "confirmed", "PI must be confirmed");
  assert.ok(storedPi.confirmedAt instanceof Date, "confirmedAt must be a Date");

  // The atomic batch guarantee: if PI is confirmed, CashMovement MUST exist.
  // Under the old sequential design, a mid-flight kill could leave PI confirmed
  // with no CashMovement (audit C-1). The new batch closes this gap.
  assert.equal(
    prisma.state.cashMovements.length,
    1,
    "CashMovement must exist when PI is confirmed (atomic batch guarantee)",
  );
  const cm = prisma.state.cashMovements[0];
  assert.equal(cm.type, "income");
  assert.equal(cm.businessId, BUSINESS_ID);
  assert.equal(cm.clientMessageId, `mp-confirm-${created.intent.paymentIntentId}`);
});

test("slice3 — duplicate CashMovement (same clientMessageId) is skipped WITHOUT rolling back PI/Sale", async () => {
  // Regression test for the 2026-05-26 incident (PI pi_example_002):
  // the original $transaction raised P2002 on CashMovement, rolling back the
  // PI update — PI stayed "pending" forever. The fix: createMany(skipDuplicates:true)
  // compiles to INSERT ... ON CONFLICT DO NOTHING. Duplicate is silently skipped
  // (cashResult.count=0), the batch commits, and outcome is "confirmed".
  const prisma = createFakePrisma();
  const useCase = loadUseCase(prisma);

  const created = await useCase.createPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    saleId: null,
    monto: 1750,
    metodo: "qr_dynamic_fake",
    idempotencyKey: "key-slice3-dedup-create",
  });
  const piId = created.intent.paymentIntentId;
  const cashKey = `mp-confirm-${piId}`;

  // Simulate a pre-existing CashMovement with the same clientMessageId —
  // as if a prior attempt wrote the cash row but died before returning.
  // This is the condition that triggered P2002 in the old design.
  prisma.state.cashMovements.push({
    id: "cm-preexisting-aaaaaaaaaa",
    businessId: BUSINESS_ID,
    saleId: null,
    type: "income",
    description: `Cobro QR confirmado (intent ${piId})`,
    amount: 1750,
    date: new Date(),
    paymentMethod: "qr",
    clientMessageId: cashKey,
  });

  // The intent is still "pending" (the prior attempt died after the cash write
  // but before confirming the PI in the old sequential design — or before
  // the batch committed in a crash scenario).
  assert.equal(
    prisma.state.paymentIntents.get(piId).estado,
    "pending",
    "PI must start as pending (prior attempt did not confirm it)",
  );

  // Now confirm: with createMany(skipDuplicates:true), the duplicate cash row
  // is silently skipped. The PI update commits atomically. No P2002 raised.
  const result = await useCase.confirmPaymentIntentUseCase({
    businessId: BUSINESS_ID,
    actorUserId: ACTOR_USER_ID,
    actorEmployeeId: null,
    paymentIntentId: piId,
    idempotencyKey: "key-slice3-dedup-confirm",
  });

  assert.equal(
    result.outcome,
    "confirmed",
    "duplicate CashMovement must NOT roll back the PI — outcome must be confirmed",
  );

  const storedPi = prisma.state.paymentIntents.get(piId);
  assert.equal(
    storedPi.estado,
    "confirmed",
    "PI estado must be confirmed even when cash insert is a duplicate",
  );

  // Only the pre-existing row; no second cash row was inserted (skipDuplicates).
  assert.equal(
    prisma.state.cashMovements.length,
    1,
    "duplicate cash must be skipped (ON CONFLICT DO NOTHING) — no second row",
  );
  assert.equal(
    prisma.state.cashMovements[0].clientMessageId,
    cashKey,
    "the pre-existing cash row must still be there unchanged",
  );
});
