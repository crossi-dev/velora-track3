const assert = require("node:assert/strict");
const test = require("node:test");

const {
  dispatchCommandLayerIntent,
} = require("../../src/app/dashboard/lib/hooks/useAssistantChat.commandLayer.ts");
const {
  _resetSaleAttemptsForTests,
} = require("../../src/app/dashboard/lib/sale-duplicate-detection.ts");
const {
  _resetPendingUnknownProductForTests,
} = require("../../src/app/dashboard/lib/unknown-product-flow.ts");

// ── Mock context helper ────────────────────────────────────────────
//
// Minimum surface needed by the dispatcher. Records every setter call
// so tests can assert what the handler did (or didn't) touch. All
// write intents that do catalog lookups should `return false` when
// the product/customer can't resolve; assert that no reply/card was
// emitted in that case.

function createMockCtx(overrides) {
  const calls = {
    appendChatHistoryEntry: [],
    appendDurableReply: [],
    appendTransientReply: [],
    setInput: [],
    setAssistantReply: [],
    setAssistantStockDraft: [],
    setAssistantConfirmationRequest: [],
    setLoadingParse: [],
  };
  const ctx = {
    products: [],
    clients: [],
    sales: [],
    currentCash: 0,
    businessCurrency: "ARS",
    appendChatHistoryEntry: (kind, text) => calls.appendChatHistoryEntry.push({ kind, text }),
    appendDurableReply: (text) => calls.appendDurableReply.push(text),
    appendTransientReply: (text) => calls.appendTransientReply.push(text),
    setInput: (v) => calls.setInput.push(v),
    setAssistantReply: (msg) => calls.setAssistantReply.push(msg),
    setAssistantStockDraft: (draft) => calls.setAssistantStockDraft.push(draft),
    setAssistantConfirmationRequest: (req) => calls.setAssistantConfirmationRequest.push(req),
    setLoadingParse: (v) => calls.setLoadingParse.push(v),
    updateProduct: async () => {},
    loadBusiness: async () => {},
    dispatchSaleAction: async () => ({}),
    ...overrides,
  };
  return { ctx, calls };
}

// ── edit_product: null catalog resolution → fall through ───────────

test("edit_product: unknown product (productId=null) → dispatcher returns false, no reply", async () => {
  const { ctx, calls } = createMockCtx({ products: [{ id: "p1", name: "Yerba", stock: 10, price: 6200 }] });
  const command = {
    matched: true,
    intent: "edit_product",
    data: { productName: "xyzzy", productId: null, newPrice: 1000 },
  };
  const handled = await dispatchCommandLayerIntent(command, "cambiá el precio de xyzzy a 1000", ctx);
  assert.equal(handled, false);
  assert.equal(calls.setAssistantReply.length, 0);
  assert.equal(calls.setAssistantConfirmationRequest.length, 0);
  assert.equal(calls.appendChatHistoryEntry.length, 0);
});

test("edit_product: stale productId (not in current catalog) → falls through", async () => {
  const { ctx, calls } = createMockCtx({ products: [{ id: "p1", name: "Yerba", stock: 10, price: 6200 }] });
  const command = {
    matched: true,
    intent: "edit_product",
    data: { productName: "yerba", productId: "p99", newPrice: 1000 },
  };
  const handled = await dispatchCommandLayerIntent(command, "cambiá el precio de yerba a 1000", ctx);
  assert.equal(handled, false);
  assert.equal(calls.setAssistantConfirmationRequest.length, 0);
});

test("edit_product: resolved product → dispatcher returns true and sets confirmation card", async () => {
  const { ctx, calls } = createMockCtx({ products: [{ id: "p1", name: "Yerba Mate 1kg", stock: 10, price: 6200 }] });
  const command = {
    matched: true,
    intent: "edit_product",
    data: { productName: "yerba", productId: "p1", newPrice: 6500 },
  };
  const handled = await dispatchCommandLayerIntent(command, "cambiá el precio de yerba a 6500", ctx);
  assert.equal(handled, true);
  assert.equal(calls.setAssistantConfirmationRequest.length, 1);
  const card = calls.setAssistantConfirmationRequest[0];
  assert.equal(card.action.type, "edit_product");
  assert.equal(card.action.product.id, "p1");
  assert.equal(card.action.value, "6500");
});

// ── stock_adjustment: null catalog resolution → fall through ───────

test("stock_adjustment: unknown product (productId=null) → falls through", async () => {
  const { ctx, calls } = createMockCtx({ products: [{ id: "p1", name: "Yerba", stock: 10, price: 6200 }] });
  const command = {
    matched: true,
    intent: "stock_adjustment",
    data: { mode: "decrease", quantity: 5, productName: "xyzzy", productId: null, reason: null },
  };
  const handled = await dispatchCommandLayerIntent(command, "descontá 5 de xyzzy", ctx);
  assert.equal(handled, false);
  assert.equal(calls.setAssistantConfirmationRequest.length, 0);
  assert.equal(calls.appendChatHistoryEntry.length, 0);
});

test("stock_adjustment: stale productId → falls through", async () => {
  const { ctx, calls } = createMockCtx({ products: [{ id: "p1", name: "Yerba", stock: 10, price: 6200 }] });
  const command = {
    matched: true,
    intent: "stock_adjustment",
    data: { mode: "decrease", quantity: 5, productName: "yerba", productId: "p99", reason: null },
  };
  const handled = await dispatchCommandLayerIntent(command, "descontá 5 de yerba", ctx);
  assert.equal(handled, false);
});

test("stock_adjustment: resolved product → returns true and sets confirmation card", async () => {
  const { ctx, calls } = createMockCtx({ products: [{ id: "p1", name: "Yerba", stock: 10, price: 6200 }] });
  const command = {
    matched: true,
    intent: "stock_adjustment",
    data: { mode: "decrease", quantity: 3, productName: "yerba", productId: "p1", reason: null },
  };
  const handled = await dispatchCommandLayerIntent(command, "descontá 3 de yerba", ctx);
  assert.equal(handled, true);
  assert.equal(calls.setAssistantConfirmationRequest.length, 1);
  assert.equal(calls.setAssistantConfirmationRequest[0].action.type, "adjust_stock");
});

// ── register_sale: already returns false on unresolved items ───────

test("register_sale: single unknown product → pauses sale, asks for price (voice-trained catalog)", async () => {
  _resetPendingUnknownProductForTests();
  const { ctx, calls } = createMockCtx({ products: [{ id: "p1", name: "Yerba", stock: 10, price: 6200 }] });
  const command = {
    matched: true,
    intent: "register_sale",
    data: {
      items: [{ productName: "xyzzy", productId: null, quantity: 2, unitPrice: null }],
      customerName: null,
      customerId: null,
      ambiguousCustomer: false,
      autoSendWhatsapp: false,
    },
  };
  const handled = await dispatchCommandLayerIntent(command, "vendí 2 xyzzy", ctx);
  assert.equal(handled, true);
  assert.ok(calls.setAssistantReply.some((r) => typeof r === "string" && r.includes("xyzzy") && r.includes("precio")));
});

test("register_sale: multiple unknown products → handles sequentially, asks for first unknown, returns true", async () => {
  _resetPendingUnknownProductForTests();
  const { ctx, calls } = createMockCtx({ products: [{ id: "p1", name: "Yerba", stock: 10, price: 6200 }] });
  const command = {
    matched: true,
    intent: "register_sale",
    data: {
      items: [
        { productName: "xyzzy", productId: null, quantity: 2, unitPrice: null },
        { productName: "zzzzz", productId: null, quantity: 1, unitPrice: null },
      ],
      customerName: null,
      customerId: null,
      ambiguousCustomer: false,
      autoSendWhatsapp: false,
    },
  };
  const handled = await dispatchCommandLayerIntent(command, "vendí 2 xyzzy y 1 zzzzz", ctx);
  assert.equal(handled, true);
  assert.ok(calls.setAssistantReply.some((r) => typeof r === "string" && r.includes("xyzzy") && r.includes("precio")));
});

test("register_sale: ambiguous customer → dispatcher returns false (pre-existing behavior)", async () => {
  const { ctx, calls } = createMockCtx({ products: [{ id: "p1", name: "Yerba", stock: 10, price: 6200 }] });
  const command = {
    matched: true,
    intent: "register_sale",
    data: {
      items: [{ productName: "yerba", productId: "p1", quantity: 2, unitPrice: 6200 }],
      customerName: "carlos",
      customerId: null,
      ambiguousCustomer: true,
      autoSendWhatsapp: false,
    },
  };
  const handled = await dispatchCommandLayerIntent(command, "vendí 2 yerba a carlos", ctx);
  assert.equal(handled, false);
});

// ── stock_load: opens draft even with unresolved items (by design) ─
//
// stock_load deliberately does NOT fall through when items don't resolve.
// The draft UI lets the user edit unresolved names before confirming,
// which is better UX than asking the AI to guess. Asserted here so a
// future refactor doesn't accidentally make it fall through.

test("stock_load: unresolved items still open the draft (not a null-fall-through case)", async () => {
  const { ctx, calls } = createMockCtx({ products: [{ id: "p1", name: "Yerba", stock: 10, price: 6200 }] });
  const command = {
    matched: true,
    intent: "stock_load",
    data: {
      items: [{ productName: "xyzzy", productId: null, quantity: 50, unitPrice: 100 }],
    },
  };
  const handled = await dispatchCommandLayerIntent(command, "cargá 50 xyzzy a 100", ctx);
  assert.equal(handled, true);
  assert.equal(calls.setAssistantStockDraft.length, 1);
});

// ── register_sale: duplicate-sale warning (phase 2c safety net) ────

test("register_sale: recent duplicate → warning in transient reply, draft still opens", async () => {
  _resetSaleAttemptsForTests();
  const nowIso = new Date().toISOString();
  const dispatchCalls = [];
  const { ctx, calls } = createMockCtx({
    products: [{ id: "p1", name: "Yerba", stock: 10, price: 100 }],
    clients: [{ id: "c1", name: "Juan", phone: null, email: null }],
    sales: [
      {
        id: "s_recent",
        date: nowIso,
        totalAmount: 200,
        customer: { id: "c1", name: "Juan" },
        items: [{ quantity: 2, unitPrice: 100, product: { id: "p1", name: "Yerba" } }],
      },
    ],
    dispatchSaleAction: async (action, payload) => {
      dispatchCalls.push({ action, payload });
      return {};
    },
  });
  const command = {
    matched: true,
    intent: "register_sale",
    data: {
      items: [{ productName: "yerba", productId: "p1", quantity: 2, unitPrice: null }],
      customerName: "juan",
      customerId: "c1",
      ambiguousCustomer: false,
      autoSendWhatsapp: false,
    },
  };
  const handled = await dispatchCommandLayerIntent(command, "vendí 2 yerbas a juan", ctx);
  assert.equal(handled, true);
  const warning = calls.appendTransientReply.find((m) => m.includes("Hace") && m.includes("venta igual"));
  assert.ok(warning, "expected duplicate-sale warning in transient reply");
  assert.ok(dispatchCalls.some((c) => c.action === "sale.draft.open"), "draft should still open");
  assert.ok(!dispatchCalls.some((c) => c.action === "sale.confirm-and-send-whatsapp"), "auto-send must NOT fire");
});

test("register_sale: duplicate DEGRADES autoSendWhatsapp to manual draft", async () => {
  _resetSaleAttemptsForTests();
  const nowIso = new Date().toISOString();
  const dispatchCalls = [];
  const { ctx } = createMockCtx({
    products: [{ id: "p1", name: "Yerba", stock: 10, price: 100 }],
    clients: [{ id: "c1", name: "Juan", phone: null, email: null }],
    sales: [
      {
        id: "s_recent",
        date: nowIso,
        totalAmount: 200,
        customer: { id: "c1", name: "Juan" },
        items: [{ quantity: 2, unitPrice: 100, product: { id: "p1", name: "Yerba" } }],
      },
    ],
    dispatchSaleAction: async (action, payload) => {
      dispatchCalls.push({ action, payload });
      return {};
    },
  });
  const command = {
    matched: true,
    intent: "register_sale",
    data: {
      items: [{ productName: "yerba", productId: "p1", quantity: 2, unitPrice: null }],
      customerName: "juan",
      customerId: "c1",
      ambiguousCustomer: false,
      autoSendWhatsapp: true, // autoSend requested — but duplicate detected
    },
  };
  await dispatchCommandLayerIntent(command, "vendí 2 yerbas a juan, mandale", ctx);
  // autoSend path should be short-circuited by the duplicate check
  assert.ok(dispatchCalls.some((c) => c.action === "sale.draft.open"));
  assert.ok(!dispatchCalls.some((c) => c.action === "sale.confirm-and-send-whatsapp"));
});

test("register_sale: no recent duplicate → normal flow, no warning", async () => {
  _resetSaleAttemptsForTests();
  const dispatchCalls = [];
  const { ctx, calls } = createMockCtx({
    products: [{ id: "p1", name: "Yerba", stock: 10, price: 100 }],
    clients: [{ id: "c1", name: "Juan", phone: null, email: null }],
    sales: [], // empty sales history
    dispatchSaleAction: async (action, payload) => {
      dispatchCalls.push({ action, payload });
      return {};
    },
  });
  const command = {
    matched: true,
    intent: "register_sale",
    data: {
      items: [{ productName: "yerba", productId: "p1", quantity: 2, unitPrice: null }],
      customerName: "juan",
      customerId: "c1",
      ambiguousCustomer: false,
      autoSendWhatsapp: false,
    },
  };
  await dispatchCommandLayerIntent(command, "vendí 2 yerbas a juan", ctx);
  const warning = calls.appendTransientReply.find((m) => m.includes("venta igual"));
  assert.equal(warning, undefined, "no warning expected when no duplicate");
});

test("register_sale: two rapid dispatches of the same sale → 2nd triggers in-memory warning", async () => {
  // Reproduces the production bug: user says "vendí 2 yerbas a carlos"
  // twice in quick succession. ctx.sales is empty both times (server
  // refresh hasn't landed yet), but the in-memory attempt buffer catches
  // the 2nd dispatch.
  _resetSaleAttemptsForTests();
  const dispatchCalls = [];
  const mkCtx = () =>
    createMockCtx({
      products: [{ id: "p1", name: "Yerba", stock: 10, price: 100 }],
      clients: [{ id: "c1", name: "Juan", phone: null, email: null }],
      sales: [], // stale — server refresh hasn't caught up
      dispatchSaleAction: async (action, payload) => {
        dispatchCalls.push({ action, payload });
        return {};
      },
    });
  const command = {
    matched: true,
    intent: "register_sale",
    data: {
      items: [{ productName: "yerba", productId: "p1", quantity: 2, unitPrice: null }],
      customerName: "juan",
      customerId: "c1",
      ambiguousCustomer: false,
      autoSendWhatsapp: false,
    },
  };

  // First dispatch — no warning
  const first = mkCtx();
  await dispatchCommandLayerIntent(command, "vendí 2 yerbas a juan", first.ctx);
  assert.equal(
    first.calls.appendTransientReply.find((m) => m.includes("venta igual")),
    undefined,
    "no warning on first dispatch",
  );

  // Second dispatch, same payload, fresh ctx (ctx.sales still empty) — warning fires via in-memory buffer
  const second = mkCtx();
  await dispatchCommandLayerIntent(command, "vendí 2 yerbas a juan", second.ctx);
  const warning = second.calls.appendTransientReply.find((m) => m.includes("venta igual"));
  assert.ok(warning, "expected warning on second rapid dispatch");
});
