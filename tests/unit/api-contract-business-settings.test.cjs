"use strict";
// Use-case-level contract test: 7 business-op settings round-trip correctly
// through updateBusinessUseCase. Verifies that each field in the input body
// reaches BusinessUpdateData with the right value (and is not coerced or lost).
//
// Was previously a route-level test mocking the old route's direct-Prisma
// shape. The route migrated to use-case + ports; this test was rewritten to
// exercise the use-case directly with in-memory fake adapters.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  updateBusinessUseCase,
} = require("../../src/application/use-cases/update-business.use-case.ts");

const BASE_BUSINESS = {
  id: "biz-settings-1",
  name: "Test Store",
  type: "retail",
  email: null,
  cuit: null,
  address: null,
  phone: null,
  whatsappPhone: null,
  openingTime: null,
  closingTime: null,
  currency: "ARS",
  taxRate: 0.21,
  ivaCondition: null,
  puntoVenta: null,
  iibb: null,
  activityStart: null,
  allowNegativeStock: false,
  defaultCustomer: "Consumidor Final",
  allowSaleWithoutCustomer: true,
  openReceiptAfterSale: false,
  autoCreateProductOnStockLoad: false,
  suggestWhatsappAfterSale: true,
  lowStockThreshold: 5,
};

function makePorts(businessOverride = {}) {
  const business = { ...BASE_BUSINESS, ...businessOverride };
  let captured = null;

  const ports = {
    business: {
      findById: async () => business,
      findCurrency: async () => business.currency,
      findByUserId: async () => business,
      findForUpdate: async () => business,
      updateInTransaction: async (_tx, _id, data) => {
        captured = data;
        return { ...business, ...data };
      },
    },
    idempotency: {
      begin: async () => ({ kind: "execute", recordId: "rec-1" }),
      complete: async () => {},
      release: async () => {},
    },
    audit: {
      recordCriticalWrite: async () => true,
    },
    transaction: {
      run: async (work) => work({}),
    },
  };

  return { ports, getCaptured: () => captured };
}

const ACTION_META = {
  actionType: "business.update",
  routeScope: "business",
  resourceType: "Business",
};

function baseInput(body) {
  return {
    businessId: "biz-settings-1",
    actorUserId: "user-1",
    actorEmployeeId: null,
    body,
    idempotencyKey: "test-key",
    requestBody: body,
    actionMeta: ACTION_META,
  };
}

// ── 7 business-op settings — round-trip via use-case ──

test("updateBusinessUseCase — allowNegativeStock true is persisted", async () => {
  const { ports, getCaptured } = makePorts();
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ allowNegativeStock: true }));
  assert.equal(result.outcome, "updated");
  assert.equal(getCaptured().allowNegativeStock, true);
  assert.equal(result.business.allowNegativeStock, true);
});

test("updateBusinessUseCase — allowNegativeStock false is respected (not coerced to true)", async () => {
  const { ports, getCaptured } = makePorts({ allowNegativeStock: true });
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ allowNegativeStock: false }));
  assert.equal(result.outcome, "updated");
  assert.equal(getCaptured().allowNegativeStock, false);
});

test("updateBusinessUseCase — defaultCustomer string is persisted", async () => {
  const { ports, getCaptured } = makePorts();
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ defaultCustomer: "Empresa ABC" }));
  assert.equal(result.outcome, "updated");
  assert.equal(getCaptured().defaultCustomer, "Empresa ABC");
});

test("updateBusinessUseCase — allowSaleWithoutCustomer false is persisted", async () => {
  const { ports, getCaptured } = makePorts();
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ allowSaleWithoutCustomer: false }));
  assert.equal(result.outcome, "updated");
  assert.equal(getCaptured().allowSaleWithoutCustomer, false);
});

test("updateBusinessUseCase — openReceiptAfterSale true is persisted", async () => {
  const { ports, getCaptured } = makePorts();
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ openReceiptAfterSale: true }));
  assert.equal(result.outcome, "updated");
  assert.equal(getCaptured().openReceiptAfterSale, true);
});

test("updateBusinessUseCase — autoCreateProductOnStockLoad true is persisted", async () => {
  const { ports, getCaptured } = makePorts();
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ autoCreateProductOnStockLoad: true }));
  assert.equal(result.outcome, "updated");
  assert.equal(getCaptured().autoCreateProductOnStockLoad, true);
});

test("updateBusinessUseCase — suggestWhatsappAfterSale false is persisted", async () => {
  const { ports, getCaptured } = makePorts();
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ suggestWhatsappAfterSale: false }));
  assert.equal(result.outcome, "updated");
  assert.equal(getCaptured().suggestWhatsappAfterSale, false);
});

test("updateBusinessUseCase — lowStockThreshold number is persisted as number", async () => {
  const { ports, getCaptured } = makePorts();
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ lowStockThreshold: 10 }));
  assert.equal(result.outcome, "updated");
  assert.equal(typeof getCaptured().lowStockThreshold, "number");
  assert.equal(getCaptured().lowStockThreshold, 10);
});

test("updateBusinessUseCase — all 7 settings updated in one call", async () => {
  const { ports, getCaptured } = makePorts();
  const useCase = updateBusinessUseCase(ports);
  const body = {
    allowNegativeStock: true,
    defaultCustomer: "Empresa XYZ",
    allowSaleWithoutCustomer: false,
    openReceiptAfterSale: true,
    autoCreateProductOnStockLoad: true,
    suggestWhatsappAfterSale: false,
    lowStockThreshold: 3,
  };
  const result = await useCase.execute(baseInput(body));
  assert.equal(result.outcome, "updated");
  const captured = getCaptured();
  assert.equal(captured.allowNegativeStock, true);
  assert.equal(captured.defaultCustomer, "Empresa XYZ");
  assert.equal(captured.allowSaleWithoutCustomer, false);
  assert.equal(captured.openReceiptAfterSale, true);
  assert.equal(captured.autoCreateProductOnStockLoad, true);
  assert.equal(captured.suggestWhatsappAfterSale, false);
  assert.equal(captured.lowStockThreshold, 3);
});

test("updateBusinessUseCase — postalCode string is persisted (shipping-quote origin)", async () => {
  const { ports, getCaptured } = makePorts();
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ postalCode: "5500" }));
  assert.equal(result.outcome, "updated");
  assert.equal(getCaptured().postalCode, "5500");
  assert.equal(result.business.postalCode, "5500");
});

test("updateBusinessUseCase — postalCode null clears the value", async () => {
  const { ports, getCaptured } = makePorts({ postalCode: "1234" });
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ postalCode: null }));
  assert.equal(result.outcome, "updated");
  assert.equal(getCaptured().postalCode, null);
});

test("updateBusinessUseCase — returns not_found when business missing", async () => {
  const { ports } = makePorts();
  ports.business.findForUpdate = async () => null;
  const useCase = updateBusinessUseCase(ports);
  const result = await useCase.execute(baseInput({ allowNegativeStock: true }));
  assert.equal(result.outcome, "not_found");
});
