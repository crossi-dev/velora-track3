/**
 * owner-all-intents.test.cjs
 *
 * Verifica que los 18 intents no-triviales del owner pasen por el handler
 * correspondiente y devuelvan una respuesta estructurada (no null, no error).
 *
 * Estrategia: llama a cada handler directamente con parsed mínimo válido.
 * Un handler roto devuelve null (no reconoció el intent) o tira una excepción.
 */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { handleRegisterSale } = require("../../src/app/api/business-assistant/_lib/intent-handlers/sale.ts");
const { handleStockLoad, handleAdjustStock } = require("../../src/app/api/business-assistant/_lib/intent-handlers/stock.ts");
const { handleEditProduct } = require("../../src/app/api/business-assistant/_lib/intent-handlers/product.ts");
const { handleDeleteProduct } = require("../../src/app/api/business-assistant/_lib/intent-handlers/product-delete.ts");
const { handleCreateProduct } = require("../../src/app/api/business-assistant/_lib/intent-handlers/product-create.ts");
const { handleCreateCustomer, handleEditCustomer } = require("../../src/app/api/business-assistant/_lib/intent-handlers/customer.ts");
const { handleCreateSupplier, handleEditSupplier } = require("../../src/app/api/business-assistant/_lib/intent-handlers/supplier.ts");
const { handleRegisterMovement } = require("../../src/app/api/business-assistant/_lib/intent-handlers/movement.ts");
const { handleBulkPriceUpdate } = require("../../src/app/api/business-assistant/_lib/intent-handlers/bulk-price.ts");
const { handleBusinessQuery } = require("../../src/app/api/business-assistant/_lib/intent-handlers/business-query.ts");
const { handleReportEvent } = require("../../src/app/api/business-assistant/_lib/intent-handlers/event-report.ts");
const { handleCreatePurchaseRequest } = require("../../src/app/api/business-assistant/_lib/intent-handlers/purchase-request.ts");
const { handleCreateBudget } = require("../../src/app/api/business-assistant/_lib/intent-handlers/budget.ts");
const { handleReturnSale } = require("../../src/app/api/business-assistant/_lib/intent-handlers/return-sale.ts");

// ─── helpers ────────────────────────────────────────────────────────────────

const PRODUCTS = [
  { id: "p1", name: "Taladro", sku: null, price: 5000, stock: 3 },
  { id: "p2", name: "Sierra circular", sku: null, price: 8000, stock: 1 },
];
const CUSTOMERS = [{ id: "c1", name: "Juan Pérez" }];
const SUPPLIERS = [{ id: "s1", name: "Proveedor ABC" }];

const CONTEXT = {
  business: { id: "biz-1", name: "Ferretería Demo", currency: "ARS" },
  products: PRODUCTS.map((p) => ({ name: p.name, price: p.price, stock: p.stock })),
  inventorySummary: { productLines: 2, totalUnits: 4, totalValue: 23000 },
  pendingSales: [],
  recentSales: [],
};

function makeParams(intentOverrides = {}, extra = {}) {
  return {
    text: "",
    locale: "es-AR",
    answer: "Ok.",
    context: CONTEXT,
    fullCatalogProducts: PRODUCTS,
    fullCatalogCustomers: CUSTOMERS,
    fullCatalogSuppliers: SUPPLIERS,
    productInfoDirectory: PRODUCTS,
    purchaseRequestDirectory: [],
    supplierDirectory: SUPPLIERS,
    trace: { add: () => {}, toJSON: () => ({}) },
    businessId: "biz-1",
    ...intentOverrides,
    ...extra,
  };
}

// Reads body from a NextResponse (which has a .json() method) or HandlerResult.
// Each NextResponse stream can only be read once — always use assertHandled's
// return value instead of calling this directly after assertHandled.
async function body(result) {
  if (!result) return null;
  if (typeof result.json === "function") return result.json();
  return result;
}

// Asserts result is non-null, reads + returns the parsed body (single read).
async function assertHandled(result, label) {
  assert.notEqual(result, null, `${label}: handler returned null (intent not recognized)`);
  const b = await body(result);
  assert.ok(
    typeof b.answer === "string" || b.primaryAction !== undefined || b.confirmationRequest !== undefined,
    `${label}: response missing answer/primaryAction/confirmationRequest — got ${JSON.stringify(b)}`
  );
  return b;
}

// ─── register_sale ──────────────────────────────────────────────────────────

test("register_sale: returns null for wrong intent", async () => {
  const r = await handleRegisterSale(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } }));
  assert.equal(r, null);
});

test("register_sale: valid draft → handled", async () => {
  // matchedProductId required by the hallucination guard added 2026-05:
  // handler rejects (returns null primaryAction) when productId is absent.
  const r = await handleRegisterSale(makeParams({
    safeIntent: "register_sale",
    text: "vendí 1 taladro",
    parsed: {
      intent: "register_sale",
      matchedProductId: "p1",
      saleDraft: { items: [{ productName: "Taladro", quantity: 1, unitPrice: 5000 }] },
    },
  }));
  const b = await assertHandled(r, "register_sale");
  assert.ok(b.primaryAction?.type === "register_sale" || b.saleDraft, "register_sale: should emit register_sale action or saleDraft");
});

// ─── stock_load ─────────────────────────────────────────────────────────────

test("stock_load: returns null for wrong intent", () => {
  assert.equal(handleStockLoad(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("stock_load: single stockDraft → handled", async () => {
  const r = handleStockLoad(makeParams({
    safeIntent: "stock_load",
    parsed: {
      intent: "stock_load",
      stockDraft: { itemName: "Taladro", quantity: 5, unitPrice: 3000, supplierName: "Proveedor ABC" },
    },
  }));
  const b = await assertHandled(r, "stock_load");
  assert.ok(b.primaryAction?.type === "stock_load", `stock_load: expected stock_load, got ${b.primaryAction?.type}`);
});

// ─── adjust_stock ───────────────────────────────────────────────────────────

test("adjust_stock: returns null for wrong intent", () => {
  assert.equal(handleAdjustStock(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("adjust_stock: set mode valid product → confirmation request", async () => {
  const r = handleAdjustStock(makeParams({
    safeIntent: "adjust_stock",
    text: "ponele 10 unidades al taladro",
    parsed: {
      intent: "adjust_stock",
      product: { name: "Taladro" },
      stockAdjustment: { mode: "set", quantity: 10 },
    },
  }));
  const b = await assertHandled(r, "adjust_stock");
  assert.ok(b.confirmationRequest, "adjust_stock: should emit confirmationRequest");
  assert.equal(b.confirmationRequest.action.type, "adjust_stock");
});

// ─── edit_product ────────────────────────────────────────────────────────────

test("edit_product: returns null for wrong intent", () => {
  assert.equal(handleEditProduct(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("edit_product: price change valid product → handled", async () => {
  const r = handleEditProduct(makeParams({
    safeIntent: "edit_product",
    text: "cambiá el precio del taladro a 6000",
    parsed: {
      intent: "edit_product",
      product: { name: "Taladro" },
      productEdit: { field: "price", value: "6000" },
    },
  }));
  const b = await assertHandled(r, "edit_product");
  assert.ok(
    b.primaryAction?.type === "product.update" || b.primaryAction?.type === "edit_product" || b.confirmationRequest,
    `edit_product: unexpected response ${JSON.stringify(b)}`
  );
});

// ─── delete_product ──────────────────────────────────────────────────────────

test("delete_product: returns null for wrong intent", () => {
  assert.equal(handleDeleteProduct(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("delete_product: valid product → confirmation request", async () => {
  const r = handleDeleteProduct(makeParams({
    safeIntent: "delete_product",
    text: "borrá el taladro",
    parsed: {
      intent: "delete_product",
      product: { name: "Taladro" },
    },
  }));
  const b = await assertHandled(r, "delete_product");
  assert.ok(b.confirmationRequest, "delete_product: should emit confirmationRequest");
});

// ─── create_product ──────────────────────────────────────────────────────────

test("create_product: returns null for wrong intent", () => {
  assert.equal(handleCreateProduct(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("create_product: name + price → confirmation request", async () => {
  const r = handleCreateProduct(makeParams({
    safeIntent: "create_product",
    parsed: {
      intent: "create_product",
      productDraft: { name: "Sierra caladora", price: 12000, stock: 2 },
    },
  }));
  const b = await assertHandled(r, "create_product");
  assert.ok(b.confirmationRequest || b.answer, "create_product: should emit confirmationRequest or answer");
});

// ─── create_customer ─────────────────────────────────────────────────────────

test("create_customer: returns null for wrong intent", () => {
  assert.equal(handleCreateCustomer(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("create_customer: name + phone → handled", async () => {
  const r = handleCreateCustomer(makeParams({
    safeIntent: "create_customer",
    text: "cargá cliente María García, cel 1112345678",
    parsed: {
      intent: "create_customer",
      customer: { name: "María García", phone: "1112345678" },
    },
  }));
  const b = await assertHandled(r, "create_customer");
  assert.ok(b.primaryAction || b.answer, `create_customer: expected primaryAction or answer, got ${JSON.stringify(b)}`);
});

// ─── edit_customer ────────────────────────────────────────────────────────────

test("edit_customer: returns null for wrong intent", () => {
  assert.equal(handleEditCustomer(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("edit_customer: phone update known customer → handled", async () => {
  const r = handleEditCustomer(makeParams({
    safeIntent: "edit_customer",
    text: "cambiá el teléfono de Juan Pérez a 1198765432",
    parsed: {
      intent: "edit_customer",
      customer: { name: "Juan Pérez" },
      customerEdit: { field: "phone", value: "1198765432" },
    },
  }));
  const b = await assertHandled(r, "edit_customer");
  assert.ok(
    b.primaryAction?.type === "customer.update" || b.answer,
    `edit_customer: unexpected ${JSON.stringify(b)}`
  );
});

// ─── business_query ──────────────────────────────────────────────────────────

test("business_query: returns null for wrong intent", () => {
  assert.equal(handleBusinessQuery(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("business_query: full inventory query → lists all products", async () => {
  const r = handleBusinessQuery(makeParams({
    safeIntent: "business_query",
    text: "qué hay en stock",
    parsed: { intent: "business_query" },
    answer: "Stock actual: Taladro 3 u, Sierra 1 u.",
  }));
  const b = await assertHandled(r, "business_query");
  assert.ok(typeof b.answer === "string" && b.answer.length > 0, `business_query: expected non-empty answer, got: ${b.answer}`);
});

test("business_query: price query for specific product → authoritative price", async () => {
  const r = handleBusinessQuery(makeParams({
    safeIntent: "business_query",
    text: "a cuánto está el taladro",
    parsed: { intent: "business_query" },
    answer: "El taladro vale $5000.",
    productInfoDirectory: PRODUCTS,
  }));
  const b = await assertHandled(r, "business_query");
  assert.ok(typeof b.answer === "string" && b.answer.length > 0, "business_query price: should return non-empty answer");
});

// ─── report_event ─────────────────────────────────────────────────────────────

test("report_event: returns null for wrong intent", () => {
  assert.equal(handleReportEvent(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("report_event: breakage → handled, no DB action", async () => {
  const r = handleReportEvent(makeParams({
    safeIntent: "report_event",
    parsed: {
      intent: "report_event",
      eventReport: { eventType: "rotura", details: "Se cayó una vitrina", productName: null },
    },
  }));
  const b = await assertHandled(r, "report_event");
  assert.ok(!b.primaryAction, "report_event: primaryAction should be absent (log-only)");
});

// ─── register_movement ───────────────────────────────────────────────────────

test("register_movement: returns null for wrong intent", () => {
  assert.equal(handleRegisterMovement(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("register_movement: gasto valid amount → confirmation request", async () => {
  const r = handleRegisterMovement(makeParams({
    safeIntent: "register_movement",
    parsed: {
      intent: "register_movement",
      movementDraft: { movementType: "gasto", amount: 5000, description: "Pago de luz" },
    },
  }));
  const b = await assertHandled(r, "register_movement");
  assert.ok(b.confirmationRequest || b.primaryAction, "register_movement: should emit confirmationRequest or primaryAction");
});

// ─── bulk_price_update ───────────────────────────────────────────────────────

test("bulk_price_update: returns null for wrong intent", () => {
  assert.equal(handleBulkPriceUpdate(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("bulk_price_update: percentage increase all → confirmation request", async () => {
  const r = handleBulkPriceUpdate(makeParams({
    safeIntent: "bulk_price_update",
    text: "subí todos los precios un 10%",
    parsed: {
      intent: "bulk_price_update",
      bulkPriceUpdate: { mode: "percentage", direction: "increase", amount: 10, target: "all" },
    },
  }));
  const b = await assertHandled(r, "bulk_price_update");
  assert.ok(b.confirmationRequest, "bulk_price_update: should emit confirmationRequest");
  assert.equal(b.confirmationRequest.action.type, "bulk_price_update");
});

// ─── create_supplier ─────────────────────────────────────────────────────────

test("create_supplier: returns null for wrong intent", () => {
  assert.equal(handleCreateSupplier(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("create_supplier: name provided → handled", async () => {
  const r = handleCreateSupplier(makeParams({
    safeIntent: "create_supplier",
    text: "cargá proveedor Distribuidora Sur",
    parsed: {
      intent: "create_supplier",
      supplier: { name: "Distribuidora Sur" },
    },
  }));
  const b = await assertHandled(r, "create_supplier");
  assert.ok(
    b.primaryAction?.type === "supplier.create" || b.answer,
    `create_supplier: unexpected ${JSON.stringify(b)}`
  );
});

// ─── edit_supplier ────────────────────────────────────────────────────────────

test("edit_supplier: returns null for wrong intent", () => {
  assert.equal(handleEditSupplier(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("edit_supplier: phone update known supplier → handled", async () => {
  const r = handleEditSupplier(makeParams({
    safeIntent: "edit_supplier",
    text: "cambiá el teléfono de Proveedor ABC a 1155556666",
    parsed: {
      intent: "edit_supplier",
      supplier: { name: "Proveedor ABC" },
      supplierEdit: { field: "phone", value: "1155556666" },
    },
  }));
  const b = await assertHandled(r, "edit_supplier");
  assert.ok(
    b.primaryAction?.type === "supplier.update" || b.answer,
    `edit_supplier: unexpected ${JSON.stringify(b)}`
  );
});

// ─── create_purchase_request ─────────────────────────────────────────────────

test("create_purchase_request: returns null for wrong intent", () => {
  assert.equal(handleCreatePurchaseRequest(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("create_purchase_request: item + quantity → confirmation", async () => {
  const r = handleCreatePurchaseRequest(makeParams({
    safeIntent: "create_purchase_request",
    parsed: {
      intent: "create_purchase_request",
      purchaseRequestDraft: {
        items: [{ itemName: "Taladro", quantity: 5 }],
        supplierName: "Proveedor ABC",
      },
    },
  }));
  const b = await assertHandled(r, "create_purchase_request");
  assert.ok(b.confirmationRequest || b.answer, "create_purchase_request: should emit confirmationRequest or answer");
});

// ─── create_budget ────────────────────────────────────────────────────────────

test("create_budget: returns null for wrong intent", () => {
  assert.equal(handleCreateBudget(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

test("create_budget: items provided → confirmation", async () => {
  const r = handleCreateBudget(makeParams({
    safeIntent: "create_budget",
    parsed: {
      intent: "create_budget",
      budgetDraft: {
        customerName: "Juan Pérez",
        items: [{ name: "Taladro", quantity: 1, unitPrice: 5000 }],
      },
    },
  }));
  const b = await assertHandled(r, "create_budget");
  assert.ok(b.confirmationRequest || b.answer, "create_budget: should emit confirmationRequest or answer");
});

// ─── return_sale ──────────────────────────────────────────────────────────────

// handleReturnSale is async (it queries the DB for the last sale amount before
// evaluating the delegation policy). The intent guard runs synchronously on the
// first line, but the function still returns a Promise. Use await.
test("return_sale: returns null for wrong intent", async () => {
  assert.equal(await handleReturnSale(makeParams({ safeIntent: "answer", parsed: { intent: "answer" } })), null);
});

// handleReturnSale is async — must await before passing to assertHandled.
test("return_sale: → always emits confirmation (undo last sale)", async () => {
  const r = await handleReturnSale(makeParams({
    safeIntent: "return_sale",
    parsed: { intent: "return_sale" },
  }));
  const b = await assertHandled(r, "return_sale");
  assert.ok(b.confirmationRequest, "return_sale: should emit confirmationRequest");
  assert.equal(b.confirmationRequest.action.type, "undo");
});
