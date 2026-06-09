// Integration test: flujo link de pago (checkout_pro_link) — de punta a punta.
//
// Cubre:
//   1. createPaymentLinkIntentUseCase — los 5 outcomes de idempotencia:
//        created | replayed | missing | conflict | in_flight
//   2. runPostConfirmSideEffects (checkout_pro_link confirmado):
//        → dispara triggerFiscalReceipt + triggerShipmentCreate
//   3. Idempotencia crítica: webhook re-entregado no manda dos comprobantes
//        ni crea dos envíos (gates: comprobanteSentAt / shipmentCreatedAt)
//   4. Post-confirm legacy (metodo != checkout_pro_link): invoca notifyCustomerOnConfirm
//   5. Resiliencia parcial: si comprobante falla, su timestamp queda null
//        (retry-eligible) y el paso de envío igual corre (y viceversa)

process.env.AUTH_SECRET = process.env.AUTH_SECRET || "test-auth-secret-not-used";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "test-client-id";
process.env.GOOGLE_CLIENT_SECRET =
  process.env.GOOGLE_CLIENT_SECRET || "test-client-secret";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("./module-hooks.cjs");

// ── Fake Prisma ──────────────────────────────────────────────────────────────

function createFakePrisma(seed = {}) {
  const business = seed.business ?? {
    id: "biz1aaaaaaaaaaaaaaaaaaaa",
    userId: "user1aaaaaaaaaaaaaaaaaaa",
    name: "Velora Test",
    currency: "ARS",
    cuit: null,
    address: null,
    ivaCondition: "Monotributista",
    puntoVenta: null,
    iibb: null,
    activityStart: null,
  };

  const state = {
    business,
    paymentIntents: new Map((seed.paymentIntents ?? []).map((p) => [p.id, { ...p }])),
    criticalWriteEvents: [],
    idempotencyRecords: new Map(),
    counters: { paymentIntent: 0, criticalWrite: 0 },
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
        const matchesUserId =
          where?.userId !== undefined && where.userId === business.userId;
        if (!matchesId && !matchesUserId) return null;
        if (!select) return { ...business };
        const out = {};
        for (const k of Object.keys(select)) {
          if (select[k]) {
            if (k === "id") out[k] = business[k];
            else out[k] = business[k] ?? null;
          }
        }
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
          matchedCustomerId: data.matchedCustomerId ?? null,
          shippingRequired: data.shippingRequired ?? false,
          shippingAddress: data.shippingAddress ?? null,
          shippingCostARS: data.shippingCostARS ?? null,
          confirmedAt: null,
          comprobanteSentAt: null,
          shipmentCreatedAt: null,
          expiresAt: data.expiresAt ?? null,
          refundedAt: null,
          refundedByEmployeeId: null,
          confirmedByEmployeeId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          // nested relation stub used by sendPaymentReceipt
          business: {
            name: business.name,
            cuit: business.cuit ?? null,
            address: business.address ?? null,
            currency: business.currency,
            ivaCondition: business.ivaCondition ?? "Monotributista",
            puntoVenta: business.puntoVenta ?? null,
            iibb: business.iibb ?? null,
            activityStart: business.activityStart ?? null,
          },
        };
        state.paymentIntents.set(id, row);
        if (!select) return { ...row };
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = row[k] ?? null;
        return out;
      },
      findUnique: async ({ where, select }) => {
        // Support both { id } and { id, businessId } filter patterns.
        let row = null;
        for (const pi of state.paymentIntents.values()) {
          if (where?.id !== undefined && pi.id !== where.id) continue;
          if (where?.businessId !== undefined && pi.businessId !== where.businessId) continue;
          row = pi;
          break;
        }
        if (!row) return null;
        if (!select) return { ...row };
        const out = {};
        for (const k of Object.keys(select)) {
          if (!select[k]) continue;
          if (k === "business") {
            // nested select — return the embedded stub, applying inner select
            const bSel = select.business?.select;
            if (!bSel) {
              out.business = row.business ?? null;
            } else {
              const b = {};
              for (const bk of Object.keys(bSel)) if (bSel[bk]) b[bk] = row.business?.[bk] ?? null;
              out.business = b;
            }
          } else {
            out[k] = row[k] ?? null;
          }
        }
        return out;
      },
      findFirst: async ({ where, select }) => {
        for (const pi of state.paymentIntents.values()) {
          if (where?.id !== undefined && pi.id !== where.id) continue;
          if (where?.businessId !== undefined && pi.businessId !== where.businessId) continue;
          if (!select) return { ...pi };
          const out = {};
          for (const k of Object.keys(select)) if (select[k]) out[k] = pi[k] ?? null;
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
    customer: {
      findUnique: async () => null,
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
        throw new Error("idempotencyRecord not found");
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
      deleteMany: async () => ({ count: 0 }),
    },
    $executeRawUnsafe: async () => 0,
  };

  return prisma;
}

// ── Module loader helper ─────────────────────────────────────────────────────

/**
 * Builds the full mock map for a given prisma instance.
 * Also stubs out every external-I/O dependency so tests run without network.
 *
 * triggerFiscalReceipt and triggerShipmentCreate behaviors are controlled via
 * the `opts` object:
 *   opts.receiptResult  — what triggerFiscalReceipt returns (default: { ok: true })
 *   opts.shipmentResult — what triggerShipmentCreate returns (default: { ok: true, agentText: "ok" })
 *   opts.notifyCalls    — array that receives paymentIntentId when notifyCustomerOnConfirm is called
 */
function makeMocks(prisma, opts = {}) {
  const receiptCalls = opts.receiptCalls ?? [];
  const shipmentCalls = opts.shipmentCalls ?? [];
  const notifyCalls = opts.notifyCalls ?? [];

  return {
    "@/lib/prisma": { prisma },
    "@/lib/cloud-logger": { cloudLog: () => {} },
    "@/lib/r2": {
      uploadPdfAndGetSignedUrl: async () => null,
      buildPdfR2Key: () => "fake/key.pdf",
    },
    "@/lib/whatsapp": {
      sendWhatsAppMessage: async () => {},
    },
    "@/lib/a2a-client": {
      sendStructured: async () => ({ text: "envio creado" }),
      A2AClientError: class A2AClientError extends Error {},
    },
    "@/lib/agent-identity": {
      signAgentAssertion: () => null,
    },
    "@/app/api/invoices/[invoiceId]/pdf/build-invoice-pdf": {
      buildInvoicePdf: async () => Buffer.from("fake-pdf"),
    },
    // Stub the heavy sub-modules so we can control their behavior per-test.
    // post-confirm.ts imports these via relative paths ("./trigger-fiscal-receipt"
    // etc.) — the module-hooks _load intercept matches the raw request string.
    "./trigger-fiscal-receipt": {
      triggerFiscalReceipt: async (id) => {
        receiptCalls.push(id);
        return opts.receiptResult ?? { ok: true };
      },
    },
    "./trigger-shipment-create": {
      triggerShipmentCreate: async (id, bizId) => {
        shipmentCalls.push({ id, bizId });
        return opts.shipmentResult ?? { ok: true, agentText: "envio ok" };
      },
    },
    "./notify-customer-on-confirm": {
      notifyCustomerOnConfirm: async (id) => {
        notifyCalls.push(id);
      },
    },
  };
}

function loadUseCase(relativePath, mocks) {
  resetSourceModules();
  clearMockModules();
  for (const [request, exports] of Object.entries(mocks)) {
    setMockModule(request, exports);
  }
  return require(`../../${relativePath}`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const BIZ_ID = "biz1aaaaaaaaaaaaaaaaaaaa";
const ACTOR_USER_ID = "user1aaaaaaaaaaaaaaaaaaa";

function baseInput(overrides = {}) {
  return {
    businessId: BIZ_ID,
    actorUserId: ACTOR_USER_ID,
    amountARS: 10000,
    description: "Compra online test",
    customerName: "Ana Test",
    matchedCustomerId: null,
    idempotencyKey: "test-key-" + Math.random().toString(36).slice(2),
    ...overrides,
  };
}

// ── createPaymentLinkIntentUseCase — 5 idempotency outcomes ─────────────────

test("createPaymentLinkIntentUseCase — created: persiste PaymentIntent con metodo checkout_pro_link", async () => {
  const prisma = createFakePrisma();
  const mocks = makeMocks(prisma);
  const { createPaymentLinkIntentUseCase } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-link-use-case.ts",
    mocks,
  );

  const result = await createPaymentLinkIntentUseCase(baseInput({ idempotencyKey: "link-created-1" }));

  assert.equal(result.outcome, "created");
  assert.ok(result.paymentIntentId, "debe devolver el id del intent creado");
  assert.equal(prisma.state.paymentIntents.size, 1);

  const stored = prisma.state.paymentIntents.get(result.paymentIntentId);
  assert.equal(stored.metodo, "checkout_pro_link");
  assert.equal(stored.estado, "pending");
  assert.equal(Number(stored.monto), 10000);
  assert.equal(stored.businessId, BIZ_ID);

  // criticalWriteEvent registrado
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  assert.equal(
    prisma.state.criticalWriteEvents[0].actionType,
    "payment_intent.create_link",
  );
});

test("createPaymentLinkIntentUseCase — replayed: misma idempotencyKey devuelve mismo intent sin duplicar", async () => {
  const prisma = createFakePrisma();
  const mocks = makeMocks(prisma);
  const { createPaymentLinkIntentUseCase } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-link-use-case.ts",
    mocks,
  );

  const input = baseInput({ idempotencyKey: "link-replay-1" });
  const r1 = await createPaymentLinkIntentUseCase(input);
  const r2 = await createPaymentLinkIntentUseCase(input);

  assert.equal(r1.outcome, "created");
  assert.equal(r2.outcome, "replayed");
  assert.equal(r1.paymentIntentId, r2.paymentIntentId, "replay devuelve el mismo id");
  assert.equal(prisma.state.paymentIntents.size, 1, "no debe duplicar el intent");
  // criticalWriteEvent solo se registra en el primer llamado
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("createPaymentLinkIntentUseCase — missing: idempotencyKey vacía devuelve outcome missing", async () => {
  const prisma = createFakePrisma();
  const mocks = makeMocks(prisma);
  const { createPaymentLinkIntentUseCase } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-link-use-case.ts",
    mocks,
  );

  const result = await createPaymentLinkIntentUseCase(
    baseInput({ idempotencyKey: "" }),
  );

  assert.equal(result.outcome, "idempotency_missing");
  assert.equal(prisma.state.paymentIntents.size, 0, "no debe crear intent con key vacía");
});

test("createPaymentLinkIntentUseCase — conflict: misma key con body distinto devuelve outcome conflict", async () => {
  const prisma = createFakePrisma();
  const mocks = makeMocks(prisma);
  const { createPaymentLinkIntentUseCase } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-link-use-case.ts",
    mocks,
  );

  const key = "link-conflict-1";
  // Primer llamado con amountARS 5000
  await createPaymentLinkIntentUseCase(baseInput({ idempotencyKey: key, amountARS: 5000 }));

  // Segundo llamado MISMA key pero amountARS distinto → conflict (hash diferente)
  const r2 = await createPaymentLinkIntentUseCase(
    baseInput({ idempotencyKey: key, amountARS: 9999 }),
  );

  assert.equal(r2.outcome, "idempotency_conflict");
  assert.equal(prisma.state.paymentIntents.size, 1, "conflict no debe crear segundo intent");
});

test("createPaymentLinkIntentUseCase — in_flight: P2002 con fila pending devuelve outcome in_flight", async () => {
  const prisma = createFakePrisma();

  // Pre-seed an idempotency record in "pending" status (simula request en vuelo)
  const key = "link-inflight-1";
  const requestBody = { amountARS: 10000, description: "Compra online test", matchedCustomerId: null };
  const { createHash } = require("node:crypto");
  function canonicalize(v) {
    if (Array.isArray(v)) return v.map(canonicalize);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k2, v2]) => [k2, canonicalize(v2)]),
      );
    }
    return v;
  }
  const requestHash = createHash("sha256")
    .update(JSON.stringify(canonicalize(requestBody)))
    .digest("hex");

  const mapKey = `${BIZ_ID}|payment_intent.create_link|${key}`;
  prisma.state.idempotencyRecords.set(mapKey, {
    id: "existing-record-id",
    businessId: BIZ_ID,
    actionType: "payment_intent.create_link",
    idempotencyKey: key,
    requestHash,
    status: "pending",   // ← in_flight
    responseStatus: null,
    responseBody: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
  });

  const mocks = makeMocks(prisma);
  const { createPaymentLinkIntentUseCase } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-link-use-case.ts",
    mocks,
  );

  const result = await createPaymentLinkIntentUseCase(baseInput({ idempotencyKey: key }));

  assert.equal(result.outcome, "idempotency_in_flight");
  assert.equal(prisma.state.paymentIntents.size, 0);
});

// ── runPostConfirmSideEffects — checkout_pro_link ────────────────────────────

test("post-confirm — checkout_pro_link: dispara comprobante y envío, estampa ambos timestamps", async () => {
  const receiptCalls = [];
  const shipmentCalls = [];
  const prisma = createFakePrisma();

  // Pre-seed un intent confirmado con shippingRequired = true
  const intentId = "pi-link-confirmed-0001";
  prisma.state.paymentIntents.set(intentId, {
    id: intentId,
    businessId: BIZ_ID,
    metodo: "checkout_pro_link",
    monto: 5000,
    estado: "confirmed",
    saleId: null,
    matchedCustomerId: null,
    shippingRequired: true,
    shippingAddress: { street: "Av. Test 123", postalCode: "1000", city: "CABA", name: "Ana", phone: "+5491100000000" },
    shippingCostARS: null,
    confirmedAt: new Date(),
    comprobanteSentAt: null,   // ← eligible
    shipmentCreatedAt: null,   // ← eligible
    expiresAt: null,
    refundedAt: null,
    refundedByEmployeeId: null,
    confirmedByEmployeeId: null,
    idempotencyKey: "link-pc-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    business: { name: "Velora Test", cuit: null, address: null, currency: "ARS", ivaCondition: "Monotributista", puntoVenta: null, iibb: null, activityStart: null },
  });

  const mocks = makeMocks(prisma, { receiptCalls, shipmentCalls });
  const { runPostConfirmSideEffects } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-post-confirm.ts",
    mocks,
  );

  await runPostConfirmSideEffects(intentId);

  assert.equal(receiptCalls.length, 1, "sendPaymentReceipt debe llamarse exactamente una vez");
  assert.equal(receiptCalls[0], intentId);
  assert.equal(shipmentCalls.length, 1, "triggerShipmentCreate debe llamarse exactamente una vez");
  assert.equal(shipmentCalls[0].id, intentId);

  const intent = prisma.state.paymentIntents.get(intentId);
  assert.ok(intent.comprobanteSentAt instanceof Date, "comprobanteSentAt debe quedar estampado");
  assert.ok(intent.shipmentCreatedAt instanceof Date, "shipmentCreatedAt debe quedar estampado");
});

// ── Idempotencia crítica: webhook re-entregado ───────────────────────────────

test("post-confirm idempotencia — comprobante ya enviado no se manda de nuevo (comprobanteSentAt gatea)", async () => {
  const receiptCalls = [];
  const shipmentCalls = [];
  const prisma = createFakePrisma();
  const intentId = "pi-link-idem-0001";
  const alreadySent = new Date(Date.now() - 5000);

  prisma.state.paymentIntents.set(intentId, {
    id: intentId,
    businessId: BIZ_ID,
    metodo: "checkout_pro_link",
    monto: 3000,
    estado: "confirmed",
    saleId: null,
    matchedCustomerId: null,
    shippingRequired: true,
    shippingAddress: { street: "Av. Test 456", postalCode: "2000", city: "Rosario", name: "Juan", phone: "+5493410000000" },
    shippingCostARS: null,
    confirmedAt: new Date(),
    comprobanteSentAt: alreadySent,  // ← YA enviado
    shipmentCreatedAt: null,          // ← envío todavía pendiente
    expiresAt: null,
    refundedAt: null,
    refundedByEmployeeId: null,
    confirmedByEmployeeId: null,
    idempotencyKey: "link-pc-idem-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    business: { name: "Velora Test", cuit: null, address: null, currency: "ARS", ivaCondition: "Monotributista", puntoVenta: null, iibb: null, activityStart: null },
  });

  const mocks = makeMocks(prisma, { receiptCalls, shipmentCalls });
  const { runPostConfirmSideEffects } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-post-confirm.ts",
    mocks,
  );

  // Primera llamada (webhook re-entregado)
  await runPostConfirmSideEffects(intentId);
  // Segunda llamada (mismo webhook re-entregado de nuevo)
  await runPostConfirmSideEffects(intentId);

  assert.equal(receiptCalls.length, 0, "comprobante NO debe mandarse: ya tenía comprobanteSentAt");
  assert.equal(shipmentCalls.length, 1, "envío debe dispararse en la primera llamada");

  // Después de la primera llamada shipmentCreatedAt se estampó → segunda llamada no lo redispara
  const intent = prisma.state.paymentIntents.get(intentId);
  assert.ok(intent.shipmentCreatedAt instanceof Date);
  // Verificar que la segunda llamada tampoco disparó envío de nuevo
  // (el array tiene solo 1 item — ya validado arriba)
});

test("post-confirm idempotencia — envío ya creado no se vuelve a crear (shipmentCreatedAt gatea)", async () => {
  const receiptCalls = [];
  const shipmentCalls = [];
  const prisma = createFakePrisma();
  const intentId = "pi-link-idem-0002";
  const alreadyShipped = new Date(Date.now() - 5000);

  prisma.state.paymentIntents.set(intentId, {
    id: intentId,
    businessId: BIZ_ID,
    metodo: "checkout_pro_link",
    monto: 7000,
    estado: "confirmed",
    saleId: null,
    matchedCustomerId: null,
    shippingRequired: true,
    shippingAddress: { street: "Av. Siempreviva 742", postalCode: "3000", city: "Santa Fe", name: "Marta", phone: "+5493420000000" },
    shippingCostARS: null,
    confirmedAt: new Date(),
    comprobanteSentAt: null,          // ← comprobante pendiente
    shipmentCreatedAt: alreadyShipped, // ← YA creado
    expiresAt: null,
    refundedAt: null,
    refundedByEmployeeId: null,
    confirmedByEmployeeId: null,
    idempotencyKey: "link-pc-idem-2",
    createdAt: new Date(),
    updatedAt: new Date(),
    business: { name: "Velora Test", cuit: null, address: null, currency: "ARS", ivaCondition: "Monotributista", puntoVenta: null, iibb: null, activityStart: null },
  });

  const mocks = makeMocks(prisma, { receiptCalls, shipmentCalls });
  const { runPostConfirmSideEffects } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-post-confirm.ts",
    mocks,
  );

  await runPostConfirmSideEffects(intentId);
  await runPostConfirmSideEffects(intentId);

  assert.equal(shipmentCalls.length, 0, "envío NO debe crearse de nuevo: ya tenía shipmentCreatedAt");
  assert.equal(receiptCalls.length, 1, "comprobante debe mandarse en la primera llamada");
  // segunda llamada no manda otro comprobante (comprobanteSentAt ya estampado)
  // receiptCalls.length sigue en 1
});

test("post-confirm idempotencia — ambos timestamps ya setados: no re-dispara ningún paso", async () => {
  const receiptCalls = [];
  const shipmentCalls = [];
  const prisma = createFakePrisma();
  const intentId = "pi-link-idem-0003";
  const alreadyDone = new Date(Date.now() - 10000);

  prisma.state.paymentIntents.set(intentId, {
    id: intentId,
    businessId: BIZ_ID,
    metodo: "checkout_pro_link",
    monto: 2000,
    estado: "confirmed",
    saleId: null,
    matchedCustomerId: null,
    shippingRequired: true,
    shippingAddress: { street: "Calle Falsa 123", postalCode: "4000", city: "Córdoba", name: "Luis", phone: "+5493510000000" },
    shippingCostARS: null,
    confirmedAt: new Date(),
    comprobanteSentAt: alreadyDone,  // ← ya hecho
    shipmentCreatedAt: alreadyDone,  // ← ya hecho
    expiresAt: null,
    refundedAt: null,
    refundedByEmployeeId: null,
    confirmedByEmployeeId: null,
    idempotencyKey: "link-pc-idem-3",
    createdAt: new Date(),
    updatedAt: new Date(),
    business: { name: "Velora Test", cuit: null, address: null, currency: "ARS", ivaCondition: "Monotributista", puntoVenta: null, iibb: null, activityStart: null },
  });

  const mocks = makeMocks(prisma, { receiptCalls, shipmentCalls });
  const { runPostConfirmSideEffects } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-post-confirm.ts",
    mocks,
  );

  // Simula un tercer re-delivery del webhook
  await runPostConfirmSideEffects(intentId);

  assert.equal(receiptCalls.length, 0, "NO debe mandar comprobante: ya tiene comprobanteSentAt");
  assert.equal(shipmentCalls.length, 0, "NO debe crear envío: ya tiene shipmentCreatedAt");
});

// ── Post-confirm legacy (metodo != checkout_pro_link) ─────────────────────────

test("post-confirm legacy — qr_dynamic_fake invoca notifyCustomerOnConfirm, no sendPaymentReceipt", async () => {
  const notifyCalls = [];
  const receiptCalls = [];
  const shipmentCalls = [];
  const prisma = createFakePrisma();
  const intentId = "pi-qr-legacy-00001";

  prisma.state.paymentIntents.set(intentId, {
    id: intentId,
    businessId: BIZ_ID,
    metodo: "qr_dynamic_fake",   // ← legacy path
    monto: 1500,
    estado: "confirmed",
    saleId: null,
    matchedCustomerId: null,
    shippingRequired: false,
    shippingAddress: null,
    shippingCostARS: null,
    confirmedAt: new Date(),
    comprobanteSentAt: null,
    shipmentCreatedAt: null,
    expiresAt: null,
    refundedAt: null,
    refundedByEmployeeId: null,
    confirmedByEmployeeId: null,
    idempotencyKey: "link-pc-legacy-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    business: { name: "Velora Test", cuit: null, address: null, currency: "ARS", ivaCondition: "Monotributista", puntoVenta: null, iibb: null, activityStart: null },
  });

  const mocks = makeMocks(prisma, { notifyCalls, receiptCalls, shipmentCalls });
  const { runPostConfirmSideEffects } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-post-confirm.ts",
    mocks,
  );

  await runPostConfirmSideEffects(intentId);

  assert.equal(notifyCalls.length, 1, "legacy path debe llamar notifyCustomerOnConfirm");
  assert.equal(notifyCalls[0], intentId);
  assert.equal(receiptCalls.length, 0, "legacy path NO debe llamar sendPaymentReceipt");
  assert.equal(shipmentCalls.length, 0, "legacy path NO debe llamar triggerShipmentCreate");
});

test("post-confirm legacy — alias_personal invoca notifyCustomerOnConfirm (no link path)", async () => {
  const notifyCalls = [];
  const receiptCalls = [];
  const prisma = createFakePrisma();
  const intentId = "pi-alias-legacy-0001";

  prisma.state.paymentIntents.set(intentId, {
    id: intentId,
    businessId: BIZ_ID,
    metodo: "alias_personal",
    monto: 2500,
    estado: "confirmed",
    saleId: null,
    matchedCustomerId: null,
    shippingRequired: false,
    shippingAddress: null,
    shippingCostARS: null,
    confirmedAt: new Date(),
    comprobanteSentAt: null,
    shipmentCreatedAt: null,
    expiresAt: null,
    refundedAt: null,
    refundedByEmployeeId: null,
    confirmedByEmployeeId: null,
    idempotencyKey: "link-pc-alias-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    business: { name: "Velora Test", cuit: null, address: null, currency: "ARS", ivaCondition: "Monotributista", puntoVenta: null, iibb: null, activityStart: null },
  });

  const mocks = makeMocks(prisma, { notifyCalls, receiptCalls });
  const { runPostConfirmSideEffects } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-post-confirm.ts",
    mocks,
  );

  await runPostConfirmSideEffects(intentId);

  assert.equal(notifyCalls.length, 1, "alias_personal usa el path legacy, no el link path");
  assert.equal(receiptCalls.length, 0);
});

// ── Resiliencia parcial: un fallo no bloquea el otro paso ────────────────────

test("resiliencia — comprobante falla: comprobanteSentAt queda null pero envío igual corre", async () => {
  const receiptCalls = [];
  const shipmentCalls = [];
  const prisma = createFakePrisma();
  const intentId = "pi-resilience-0001";

  prisma.state.paymentIntents.set(intentId, {
    id: intentId,
    businessId: BIZ_ID,
    metodo: "checkout_pro_link",
    monto: 8000,
    estado: "confirmed",
    saleId: null,
    matchedCustomerId: null,
    shippingRequired: true,
    shippingAddress: { street: "Av. Resiliente 1", postalCode: "5000", city: "Mendoza", name: "Pedro", phone: "+5492610000000" },
    shippingCostARS: null,
    confirmedAt: new Date(),
    comprobanteSentAt: null,
    shipmentCreatedAt: null,
    expiresAt: null,
    refundedAt: null,
    refundedByEmployeeId: null,
    confirmedByEmployeeId: null,
    idempotencyKey: "link-resilience-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    business: { name: "Velora Test", cuit: null, address: null, currency: "ARS", ivaCondition: "Monotributista", puntoVenta: null, iibb: null, activityStart: null },
  });

  const mocks = makeMocks(prisma, {
    receiptCalls,
    shipmentCalls,
    receiptResult: { ok: false, reason: "twilio_error" }, // ← falla el comprobante
    shipmentResult: { ok: true, agentText: "envio ok" },
  });
  const { runPostConfirmSideEffects } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-post-confirm.ts",
    mocks,
  );

  await runPostConfirmSideEffects(intentId);

  const intent = prisma.state.paymentIntents.get(intentId);

  assert.equal(receiptCalls.length, 1, "se intentó mandar comprobante (aunque falló)");
  assert.equal(intent.comprobanteSentAt, null, "comprobanteSentAt debe quedar null (retry-eligible)");

  assert.equal(shipmentCalls.length, 1, "el envío debe correr igual, independiente del comprobante");
  assert.ok(intent.shipmentCreatedAt instanceof Date, "shipmentCreatedAt debe estamparse");
});

test("resiliencia — envío falla: shipmentCreatedAt queda null pero comprobante igual corre", async () => {
  const receiptCalls = [];
  const shipmentCalls = [];
  const prisma = createFakePrisma();
  const intentId = "pi-resilience-0002";

  prisma.state.paymentIntents.set(intentId, {
    id: intentId,
    businessId: BIZ_ID,
    metodo: "checkout_pro_link",
    monto: 4500,
    estado: "confirmed",
    saleId: null,
    matchedCustomerId: null,
    shippingRequired: true,
    shippingAddress: { street: "Calle Logística 99", postalCode: "6000", city: "Mar del Plata", name: "Clara", phone: "+5492230000000" },
    shippingCostARS: null,
    confirmedAt: new Date(),
    comprobanteSentAt: null,
    shipmentCreatedAt: null,
    expiresAt: null,
    refundedAt: null,
    refundedByEmployeeId: null,
    confirmedByEmployeeId: null,
    idempotencyKey: "link-resilience-2",
    createdAt: new Date(),
    updatedAt: new Date(),
    business: { name: "Velora Test", cuit: null, address: null, currency: "ARS", ivaCondition: "Monotributista", puntoVenta: null, iibb: null, activityStart: null },
  });

  const mocks = makeMocks(prisma, {
    receiptCalls,
    shipmentCalls,
    receiptResult: { ok: true },
    shipmentResult: { ok: false, reason: "andreani_timeout" }, // ← falla el envío
  });
  const { runPostConfirmSideEffects } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-post-confirm.ts",
    mocks,
  );

  await runPostConfirmSideEffects(intentId);

  const intent = prisma.state.paymentIntents.get(intentId);

  assert.equal(receiptCalls.length, 1, "comprobante debe correr y llamarse");
  assert.ok(intent.comprobanteSentAt instanceof Date, "comprobanteSentAt debe estamparse");

  assert.equal(shipmentCalls.length, 1, "se intentó crear envío (aunque falló)");
  assert.equal(intent.shipmentCreatedAt, null, "shipmentCreatedAt debe quedar null (retry-eligible)");
});

// ── checkout_pro_link sin shippingRequired: solo comprobante, sin envío ──────

test("post-confirm — checkout_pro_link sin shippingRequired: solo dispara comprobante", async () => {
  const receiptCalls = [];
  const shipmentCalls = [];
  const prisma = createFakePrisma();
  const intentId = "pi-link-noshipping-001";

  prisma.state.paymentIntents.set(intentId, {
    id: intentId,
    businessId: BIZ_ID,
    metodo: "checkout_pro_link",
    monto: 2000,
    estado: "confirmed",
    saleId: null,
    matchedCustomerId: null,
    shippingRequired: false,   // ← sin envío
    shippingAddress: null,
    shippingCostARS: null,
    confirmedAt: new Date(),
    comprobanteSentAt: null,
    shipmentCreatedAt: null,
    expiresAt: null,
    refundedAt: null,
    refundedByEmployeeId: null,
    confirmedByEmployeeId: null,
    idempotencyKey: "link-noshipping-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    business: { name: "Velora Test", cuit: null, address: null, currency: "ARS", ivaCondition: "Monotributista", puntoVenta: null, iibb: null, activityStart: null },
  });

  const mocks = makeMocks(prisma, { receiptCalls, shipmentCalls });
  const { runPostConfirmSideEffects } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-post-confirm.ts",
    mocks,
  );

  await runPostConfirmSideEffects(intentId);

  assert.equal(receiptCalls.length, 1, "comprobante debe mandarse");
  assert.equal(shipmentCalls.length, 0, "no debe crear envío si shippingRequired = false");

  const intent = prisma.state.paymentIntents.get(intentId);
  assert.ok(intent.comprobanteSentAt instanceof Date);
  assert.equal(intent.shipmentCreatedAt, null);
});

// ── intent inexistente: post-confirm no explota ───────────────────────────────

test("post-confirm — intent inexistente: no lanza excepción (devuelve silenciosamente)", async () => {
  const prisma = createFakePrisma();
  const mocks = makeMocks(prisma);
  const { runPostConfirmSideEffects } = loadUseCase(
    "src/app/api/payment-intents/_lib/payment-intent-post-confirm.ts",
    mocks,
  );

  // No debe lanzar — el código ya maneja el caso con cloudLog + return
  await assert.doesNotReject(
    () => runPostConfirmSideEffects("pi-nonexistent-00000001"),
    "runPostConfirmSideEffects nunca debe lanzar aunque no encuentre el intent",
  );
});
