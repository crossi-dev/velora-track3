const assert = require("node:assert/strict");
const test = require("node:test");

// ── mapCreatePurchaseRequest (via supervisor-action-mapper) ──────────────────
// Verifies that null quantity from the supervisor is preserved as null in the
// resulting CompoundAction — not coerced to 0.

const {
  mapSupervisorActionsToCompoundActions,
} = require("../../src/app/api/business-assistant/_lib/supervisor-action-mapper.ts");

test("mapCreatePurchaseRequest: preserves null quantity when supervisor emits null", () => {
  const actions = mapSupervisorActionsToCompoundActions(
    [
      {
        intent: "create_purchase_request",
        data: { itemName: "harina", supplierName: "Molinos SA", quantity: null, unitPrice: null },
        summary: "Pedir harina a Molinos SA",
      },
    ],
    [],
    [],
    [],
  );

  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "create_purchase_request");
  assert.equal(
    actions[0].quantity,
    null,
    "quantity must be null — 'owner did not say' must not collapse into 0",
  );
});

test("mapCreatePurchaseRequest: preserves numeric quantity when supervisor emits a number", () => {
  const actions = mapSupervisorActionsToCompoundActions(
    [
      {
        intent: "create_purchase_request",
        data: { itemName: "cemento", supplierName: "Cementera ABC", quantity: 100, unitPrice: 2000 },
        summary: "Pedir 100 bolsas de cemento",
      },
    ],
    [],
    [],
    [],
  );

  assert.equal(actions.length, 1);
  assert.equal(actions[0].quantity, 100);
});

// ── handleCreatePurchaseRequest (intent handler) ─────────────────────────────
// Verifies that a null quantity does not crash the handler and produces a
// sensible confirmation message.

const {
  handleCreatePurchaseRequest,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/purchase-request.ts");

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "create_purchase_request",
    answer: "Listo, armé el pedido.",
    parsed: { intent: "create_purchase_request" },
    context: {},
    fullCatalogProducts: [],
    fullCatalogCustomers: [],
    fullCatalogSuppliers: [],
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

test("handleCreatePurchaseRequest: null quantity does not crash handler and includes item name", async () => {
  const res = handleCreatePurchaseRequest(
    makeParams({
      parsed: {
        intent: "create_purchase_request",
        purchaseRequestDraft: {
          supplierName: "Distribuidora Norte",
          items: [{ itemName: "clavos", quantity: null, unitPrice: null }],
        },
      },
    }),
  );
  assert.ok(res !== null, "handler must return a response (not fall through)");
  const data = await res.json();
  assert.ok(
    typeof data.answer === "string",
    "answer must be a string",
  );
  assert.match(data.answer, /clavos/, "answer must mention the item name");
  // Confirm that '0' does not appear (null must not be coerced to 0 in the label)
  assert.ok(
    !data.answer.includes("0 ×"),
    `answer must not render '0 ×'; got: ${data.answer}`,
  );
});

test("handleCreatePurchaseRequest: null quantity action forwarded with null (not 0)", async () => {
  const res = handleCreatePurchaseRequest(
    makeParams({
      parsed: {
        intent: "create_purchase_request",
        purchaseRequestDraft: {
          supplierName: null,
          items: [{ itemName: "tornillos", quantity: null, unitPrice: null }],
        },
      },
    }),
  );
  const data = await res.json();
  assert.ok(data.confirmationRequest, "must include a confirmationRequest");
  assert.equal(
    data.confirmationRequest.action.quantity,
    null,
    "confirmationRequest.action.quantity must be null — not 0",
  );
});
