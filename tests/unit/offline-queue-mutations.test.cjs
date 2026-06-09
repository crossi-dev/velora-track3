const assert = require("node:assert/strict");
const test = require("node:test");

// Stub minimal de localStorage + window para que offline-queue.ts cargue
// sin DOM. La implementación detecta `typeof window !== "undefined"` —
// proveemos un mock antes de require para que funcione.
const storage = new Map();
globalThis.window = globalThis.window || {};
globalThis.localStorage = {
  getItem: (k) => storage.has(k) ? storage.get(k) : null,
  setItem: (k, v) => storage.set(k, String(v)),
  removeItem: (k) => storage.delete(k),
  clear: () => storage.clear(),
};
globalThis.window.addEventListener = () => {};
globalThis.window.removeEventListener = () => {};
globalThis.window.dispatchEvent = () => true;
// crypto.randomUUID está disponible en Node 20+ — no lo stubeamos.

const {
  enqueueSaleCreate,
  enqueueStockLoad,
  enqueueCashMovement,
  clear,
} = require("../../src/app/dashboard/lib/offline-queue.ts");

function reset() {
  clear();
  storage.clear();
}

test("enqueueSaleCreate: encola con shape correcto + idempotencyKey", () => {
  reset();
  const entry = enqueueSaleCreate({
    customerId: null,
    customerName: "Juan",
    items: [{ productId: "p-1", productName: "Cubiertas", quantity: 2, unitPrice: 50000 }],
  });
  assert.equal(entry.type, "sale.create");
  assert.equal(entry.attempts, 0);
  assert.ok(entry.idempotencyKey, "should have idempotencyKey");
  assert.ok(entry.id);
  assert.equal(entry.payload.items[0].quantity, 2);
  assert.equal(entry.payload.items[0].productId, "p-1");
});

test("enqueueSaleCreate: respeta idempotencyKey explícito", () => {
  reset();
  const entry = enqueueSaleCreate(
    { customerId: null, customerName: "CF", items: [{ productId: "p-x", productName: "X", quantity: 1, unitPrice: 100 }] },
    "fixed-key-123",
  );
  assert.equal(entry.idempotencyKey, "fixed-key-123");
});

test("enqueueStockLoad: encola con type stock.load", () => {
  reset();
  const entry = enqueueStockLoad({
    items: [{ productId: "p-cem", itemName: "Cemento", quantity: 50, unitPrice: 8000 }],
    supplierName: "Loma Negra",
  });
  assert.equal(entry.type, "stock.load");
  assert.equal(entry.payload.supplierName, "Loma Negra");
});

test("enqueueCashMovement: encola con type cash.movement", () => {
  reset();
  const entry = enqueueCashMovement({
    type: "purchase",
    description: "Pago proveedor",
    amount: 50000,
  });
  assert.equal(entry.type, "cash.movement");
  assert.equal(entry.payload.amount, 50000);
});

test("idempotencyKey único entre encolados consecutivos", () => {
  reset();
  const a = enqueueSaleCreate({ customerId: null, customerName: "CF", items: [{ productId: "p1", productName: "X", quantity: 1, unitPrice: 1 }] });
  const b = enqueueSaleCreate({ customerId: null, customerName: "CF", items: [{ productId: "p2", productName: "Y", quantity: 1, unitPrice: 1 }] });
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.id, b.id);
});

// ── Phase 1: validator acepta todos los types ──────────────────────────
// Bug previo: isValidQueuedAction hardcoded `type === "assistant.chat"`,
// dropeaba sale/stock/cash al releer localStorage. Estos tests verifican
// que al re-leer la envelope, los items persisten.

const { OFFLINE_QUEUE_KEY } = require("../../src/app/dashboard/lib/offline-queue.ts");

function rewriteEnvelope(items) {
  storage.set(OFFLINE_QUEUE_KEY, JSON.stringify({ version: 1, items }));
}

test("validator: sale.create persiste tras releer envelope", () => {
  reset();
  const items = [{
    type: "sale.create",
    id: "test-id-sale",
    idempotencyKey: "key-sale",
    queuedAt: Date.now(),
    attempts: 0,
    payload: {
      customerId: null,
      customerName: "Juan",
      items: [{ productId: "p1", productName: "Cubiertas", quantity: 2, unitPrice: 50000 }],
    },
  }];
  rewriteEnvelope(items);
  const all = require("../../src/app/dashboard/lib/offline-queue.ts").getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].type, "sale.create");
});

test("validator: stock.load persiste tras releer envelope", () => {
  reset();
  const items = [{
    type: "stock.load",
    id: "test-id-stock",
    idempotencyKey: "key-stock",
    queuedAt: Date.now(),
    attempts: 0,
    payload: {
      items: [{ productId: "p1", itemName: "Cemento", quantity: 50, unitPrice: 8000 }],
      supplierName: "Loma Negra",
    },
  }];
  rewriteEnvelope(items);
  const all = require("../../src/app/dashboard/lib/offline-queue.ts").getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].type, "stock.load");
});

test("validator: cash.movement persiste tras releer envelope", () => {
  reset();
  const items = [{
    type: "cash.movement",
    id: "test-id-cash",
    idempotencyKey: "key-cash",
    queuedAt: Date.now(),
    attempts: 0,
    payload: { type: "purchase", description: "X", amount: 5000 },
  }];
  rewriteEnvelope(items);
  const all = require("../../src/app/dashboard/lib/offline-queue.ts").getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].type, "cash.movement");
});

test("validator: type unknown se rechaza", () => {
  reset();
  const items = [{
    type: "unknown.type",
    id: "test-id",
    idempotencyKey: "k",
    queuedAt: Date.now(),
    attempts: 0,
    payload: {},
  }];
  rewriteEnvelope(items);
  const all = require("../../src/app/dashboard/lib/offline-queue.ts").getAll();
  assert.equal(all.length, 0, "items con type unknown se filtran");
});

test("validator: payload inválido se rechaza (sale sin items)", () => {
  reset();
  const items = [{
    type: "sale.create",
    id: "test-id",
    idempotencyKey: "k",
    queuedAt: Date.now(),
    attempts: 0,
    payload: { customerId: null, customerName: "X", items: [] }, // empty items
  }];
  rewriteEnvelope(items);
  const all = require("../../src/app/dashboard/lib/offline-queue.ts").getAll();
  assert.equal(all.length, 0, "sale.create con items vacío se rechaza");
});

test("validator: assistant.chat sigue funcionando (regresión)", () => {
  reset();
  const items = [{
    type: "assistant.chat",
    id: "test-id-chat",
    idempotencyKey: "k",
    queuedAt: Date.now(),
    attempts: 0,
    payload: { text: "hola" },
  }];
  rewriteEnvelope(items);
  const all = require("../../src/app/dashboard/lib/offline-queue.ts").getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].type, "assistant.chat");
});
