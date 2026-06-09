const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleCreateBudgetCommand,
} = require("../../src/app/dashboard/lib/hooks/useAssistantChat.createBudget.ts");

// The hook's only non-trivial logic is the per-item unitPrice resolution:
//   1. Explicit i.unitPrice wins
//   2. Otherwise look up i.productId in the catalog
//   3. Otherwise fall back to 0
// Each branch is a real business rule (parser may capture price or not, and
// the catalog may or may not have a matching productId). These are the only
// branches Zod cannot guarantee.
function makeFakeCtx({ products = [], businessCurrency = "ARS" } = {}) {
  const captured = { confirmationRequest: null };
  return {
    captured,
    products,
    businessCurrency,
    appendChatHistoryEntry: () => {},
    setInput: () => {},
    setLoadingParse: () => {},
    setAssistantReply: () => {},
    appendTransientReply: () => {},
    setAssistantConfirmationRequest: (req) => { captured.confirmationRequest = req; },
  };
}

test("handleCreateBudgetCommand: items with explicit unitPrice keep that price (no catalog lookup)", async () => {
  const ctx = makeFakeCtx({
    products: [{ id: "p1", name: "Yerba", price: 6200 }], // catalog price differs
  });
  const command = {
    matched: true,
    intent: "create_budget",
    data: {
      customerName: "Juan",
      items: [{ productName: "yerba", productId: "p1", quantity: 5, unitPrice: 5000 }],
      autoSendWhatsapp: false,
    },
  };
  const handled = await handleCreateBudgetCommand(command, "presupuesto para Juan: 5 yerba a 5000", ctx);
  assert.equal(handled, true);
  const action = ctx.captured.confirmationRequest.action;
  assert.equal(action.type, "create_budget");
  assert.equal(action.items[0].unitPrice, 5000); // explicit price preserved, NOT 6200
});

test("handleCreateBudgetCommand: items without unitPrice fall back to the catalog price for the resolved productId", async () => {
  const ctx = makeFakeCtx({
    products: [
      { id: "p1", name: "Yerba", price: 6200 },
      { id: "p2", name: "Azúcar", price: 1800 },
    ],
  });
  const command = {
    matched: true,
    intent: "create_budget",
    data: {
      customerName: "Juan",
      items: [
        { productName: "yerba", productId: "p1", quantity: 2, unitPrice: null },
        { productName: "azúcar", productId: "p2", quantity: 3, unitPrice: null },
      ],
      autoSendWhatsapp: false,
    },
  };
  const handled = await handleCreateBudgetCommand(command, "presupuesto para Juan", ctx);
  assert.equal(handled, true);
  const action = ctx.captured.confirmationRequest.action;
  assert.equal(action.items[0].unitPrice, 6200); // resolved from catalog
  assert.equal(action.items[1].unitPrice, 1800);
});

test("handleCreateBudgetCommand: items without unitPrice AND without productId default to 0 (parser couldn't resolve product)", async () => {
  const ctx = makeFakeCtx({
    products: [{ id: "p1", name: "Yerba", price: 6200 }],
  });
  const command = {
    matched: true,
    intent: "create_budget",
    data: {
      customerName: "Juan",
      items: [
        { productName: "producto desconocido", productId: null, quantity: 1, unitPrice: null },
      ],
      autoSendWhatsapp: false,
    },
  };
  const handled = await handleCreateBudgetCommand(command, "presupuesto para Juan", ctx);
  assert.equal(handled, true);
  const action = ctx.captured.confirmationRequest.action;
  assert.equal(action.items[0].unitPrice, 0); // fallback when neither explicit nor catalog-resolvable
});
