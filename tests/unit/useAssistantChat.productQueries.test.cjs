const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleProductQueryCommand,
} = require("../../src/app/dashboard/lib/hooks/useAssistantChat.productQueries.ts");

// Minimal capturing fake of CommandLayerDispatchContext. The dispatchHelpers
// module mutates ctx via these methods; we record the final state to assert
// on the BRANCH BEHAVIOR of the hook (resolved productId vs fuzzy suggestion
// vs not-found reply). The 400ms artificial delay inside emitTextReply /
// emitConfirmationCard is awaited as part of each test.
function makeFakeCtx({ products = [], businessCurrency = "ARS" } = {}) {
  const captured = {
    chatHistory: [],
    durableReplies: [],
    transientReplies: [],
    assistantReply: null,
    confirmationRequest: null,
  };
  return {
    captured,
    products,
    businessCurrency,
    appendChatHistoryEntry: (kind, text) => captured.chatHistory.push({ kind, text }),
    setInput: () => {},
    setLoadingParse: () => {},
    setAssistantReply: (val) => { captured.assistantReply = val; },
    appendDurableReply: (val) => captured.durableReplies.push(val),
    appendTransientReply: (val) => captured.transientReplies.push(val),
    setAssistantConfirmationRequest: (req) => { captured.confirmationRequest = req; },
  };
}

// ── check_stock ───────────────────────────────────────────────────────

test("handleProductQueryCommand: check_stock with resolved productId emits a stock-count text reply", async () => {
  const ctx = makeFakeCtx({
    products: [{ id: "p1", name: "Yerba Mate", stock: 12, price: 6200 }],
  });
  const command = { matched: true, intent: "check_stock", data: { productId: "p1", productName: "yerba" } };
  const handled = await handleProductQueryCommand(command, "cuántas yerbas tengo", ctx);
  assert.equal(handled, true);
  assert.match(ctx.captured.assistantReply, /Yerba Mate.*12 unidades/);
  assert.equal(ctx.captured.confirmationRequest, null);
});

test("handleProductQueryCommand: check_stock with unresolved productId + fuzzy match emits a fuzzy_product_query confirmation card", async () => {
  const ctx = makeFakeCtx({
    products: [{ id: "p1", name: "Yerba", stock: 8, price: 100 }],
  });
  // "yerva" — 1 edit-distance from "yerba" → suggestProductMatch returns the catalog entry
  const command = { matched: true, intent: "check_stock", data: { productId: null, productName: "yerva" } };
  const handled = await handleProductQueryCommand(command, "cuántas yervas tengo", ctx);
  assert.equal(handled, true);
  assert.ok(ctx.captured.confirmationRequest);
  assert.equal(ctx.captured.confirmationRequest.action.type, "fuzzy_product_query");
  assert.equal(ctx.captured.confirmationRequest.action.originalIntent, "check_stock");
  assert.equal(ctx.captured.confirmationRequest.action.productId, "p1");
});

test("handleProductQueryCommand: check_stock with unresolved productId + no fuzzy match emits a not-found text reply", async () => {
  const ctx = makeFakeCtx({ products: [] }); // empty catalog → suggestProductMatch returns null
  const command = { matched: true, intent: "check_stock", data: { productId: null, productName: "fernet" } };
  const handled = await handleProductQueryCommand(command, "cuántos fernet hay", ctx);
  assert.equal(handled, true);
  assert.match(ctx.captured.assistantReply, /No encontré.*fernet/);
  assert.equal(ctx.captured.confirmationRequest, null);
});

// ── product_price_query ───────────────────────────────────────────────

test("handleProductQueryCommand: product_price_query with resolved productId emits a price text reply", async () => {
  const ctx = makeFakeCtx({
    products: [{ id: "p1", name: "Yerba Mate", stock: 12, price: 6200 }],
  });
  const command = { matched: true, intent: "product_price_query", data: { productId: "p1", productName: "yerba" } };
  const handled = await handleProductQueryCommand(command, "cuánto vale la yerba", ctx);
  assert.equal(handled, true);
  // buildProductPriceReply formats with es-AR currency; just verify the product name appears
  assert.match(ctx.captured.assistantReply, /Yerba Mate/);
  assert.equal(ctx.captured.confirmationRequest, null);
});

test("handleProductQueryCommand: product_price_query unresolved + fuzzy match emits a fuzzy confirmation card with originalIntent=product_price_query", async () => {
  const ctx = makeFakeCtx({
    products: [{ id: "p1", name: "Yerba", stock: 1, price: 100 }],
  });
  const command = { matched: true, intent: "product_price_query", data: { productId: null, productName: "yerva" } };
  const handled = await handleProductQueryCommand(command, "cuánto vale la yerva", ctx);
  assert.equal(handled, true);
  assert.ok(ctx.captured.confirmationRequest);
  assert.equal(ctx.captured.confirmationRequest.action.type, "fuzzy_product_query");
  assert.equal(ctx.captured.confirmationRequest.action.originalIntent, "product_price_query");
});
