const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  clearMockModules,
  resetSourceModules,
  setMockModule,
} = require("./module-hooks.cjs");

// Pads a prefix+counter into a CUID-shaped 24-char id so it passes the
// route schemas' /^[a-z0-9]{20,30}$/ regex. Example: padId("sale", 1) → "sale1aaaaaaaaaaaaaaaaaaa".
function padId(prefix, n) {
  const stripped = `${prefix}${n}`;
  if (stripped.length >= 20) return stripped;
  return stripped + "a".repeat(24 - stripped.length);
}

function makeBusiness(overrides = {}) {
  return {
    id: "biz1aaaaaaaaaaaaaaaaaaaa",
    userId: "user1aaaaaaaaaaaaaaaaaaa",
    name: "Velora",
    currency: "ARS",
    whatsappPhone: null,
    cuit: null,
    address: null,
    ivaCondition: null,
    puntoVenta: "0001",
    iibb: null,
    activityStart: null,
    ...overrides,
  };
}

function makeCustomer(overrides = {}) {
  return {
    id: "cust1aaaaaaaaaaaaaaaaaaa",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    name: "Acme",
    email: null,
    phone: null,
    taxId: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    updatedAt: new Date("2024-01-01T00:00:00.000Z"),
    salesCount: 0,
    ...overrides,
  };
}

function makeSupplier(overrides = {}) {
  return {
    id: "sup1aaaaaaaaaaaaaaaaaaaa",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    name: "Paper Co",
    phone: null,
    email: null,
    contactName: null,
    ...overrides,
  };
}

function makeProduct(overrides = {}) {
  return {
    id: "prod1aaaaaaaaaaaaaaaaaaa",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    name: "Widget",
    sku: null,
    price: 100,
    costPrice: null,
    reorderThreshold: 5,
    quantity: 0,
    ...overrides,
  };
}

function makeInventory(product, overrides = {}) {
  return {
    productId: product.id,
    quantity: 10,
    lastUpdated: new Date("2024-01-01T00:00:00.000Z"),
    product,
    ...overrides,
  };
}

function makeStockMovement(overrides = {}) {
  return {
    id: "stock1aaaaaaaaaaaaaaaaaa",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    productId: "prod1aaaaaaaaaaaaaaaaaaa",
    productName: "Widget",
    quantityBefore: 6,
    quantityAfter: 8,
    delta: 2,
    reason: "stock_load",
    referenceId: "movement1aaaaaaaaaaaaaaa",
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function makeSale(overrides = {}) {
  return {
    id: "sale1aaaaaaaaaaaaaaaaaaa",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    customerId: "cust1aaaaaaaaaaaaaaaaaaa",
    date: new Date(),
    totalAmount: 200,
    taxAmount: 0,
    status: "completed",
    ...overrides,
  };
}

function makeInvoice(overrides = {}) {
  return {
    id: "inv1aaaaaaaaaaaaaaaaaaaa",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    saleId: "sale1aaaaaaaaaaaaaaaaaaa",
    invoiceNumber: "REC-0001-00000001",
    issuedAt: new Date(),
    currency: "ARS",
    totalAmount: 200,
    payloadJson: "{}",
    documentType: "receipt",
    sequenceNumber: 1,
    status: "issued",
    ...overrides,
  };
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function makeNextServerMock() {
  return {
    NextRequest: class NextRequest {},
    NextResponse: {
      json: jsonResponse,
    },
  };
}

function makeModuleMocks({ prisma, authUserId = "user1aaaaaaaaaaaaaaaaaaa", sendWhatsAppMessage = async () => {} }) {
  return {
    "next/server": makeNextServerMock(),
    "@/lib/prisma": { prisma },
    "@/auth": {
      auth: async () => ({ user: { id: authUserId } }),
      signIn: async () => {},
      signOut: async () => {},
      ensureBusinessPlaceholder: async () => {},
    },
    "@/lib/whatsapp": {
      sendWhatsAppMessage,
    },
  };
}

function loadRoute(routeRelativePath, mocks) {
  resetSourceModules();
  clearMockModules();

  for (const [request, exports] of Object.entries(mocks)) {
    setMockModule(request, exports);
  }

  return require(path.join(process.cwd(), routeRelativePath));
}

function makeRequest(body, idempotencyKey) {
  return {
    headers: new Headers(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
    async json() {
      return body;
    },
  };
}

// ─── Fake Prisma harness: known divergences from real Prisma ────────────────
//
// This in-memory simulator covers the query shapes the route handlers
// actually use. The places it diverges from a real Postgres + Prisma are
// listed below. New tests should NOT rely on behavior that only the fake
// supports, and reviewers should treat these as silent gaps when judging
// whether a phase4 test would catch a real production bug.
//
//   1. $transaction = (cb) => cb(prisma) — synchronous passthrough.
//      No rollback on throw, no isolation between concurrent callers.
//      A handler that does `tx.X.create(...)` then throws will leave the
//      write in state.X. If the production code relies on transaction
//      atomicity (and it does — every undo handler does), bugs where a
//      partial mutation persists past a thrown error will NOT fail tests.
//
//   2. idempotencyRecord.deleteMany({ where: { responseBody: { contains } } })
//      uses String.prototype.includes — substring match, not Postgres
//      `LIKE`. Tests with short IDs (e.g. "sale1aaaaaaaaaaaaaaaaaaa") will match other
//      records that happen to contain that as a substring (e.g. "sale12aaaaaaaaaaaaaaaaaa").
//
//   3. $executeRawUnsafe parses params POSITIONALLY:
//        const [id, businessId, actorUserId, routeScope, ...] = params;
//      If the production SQL reorders bound parameters, the fake silently
//      maps them into the wrong fields. Tests that don't assert on
//      payloadJson / summary will not notice the corruption.
//
//   4. recordCriticalWriteEvent has two code paths: prisma.criticalWriteEvent.create
//      and $executeRawUnsafe INSERT. Both paths are mocked. Tests don't
//      verify which path the production code took, so a regression that
//      switches paths under a feature flag goes unnoticed.
//
//   5. supplier.findMany() with no `where` returns suppliers for the DEFAULT
//      business. A handler that forgets to scope by businessId silently
//      reads the right set in the fake but would leak across tenants in
//      production. Same applies to product.findMany.
//
//   6. take + orderBy: the fake respects `take` even when `orderBy` is
//      omitted (returns first N by insertion order). Real Postgres
//      without ORDER BY is non-deterministic. Tests that assert "the
//      most recent N" without enforcing orderBy in the query may pass
//      against the fake but flake in production.
//
//   7. Numeric types: the fake stores all numbers as JS Number. Real
//      Prisma Decimal columns return Decimal objects (with .toString(),
//      .toFixed(), etc.). Code that does Number.isFinite() on a Decimal
//      may behave differently against the fake vs production.
//
// When a test would only pass because of one of the divergences above,
// flag it in review and add an integration test against a real DB.
function createFakePrisma(seed = {}) {
  const business = seed.business ?? makeBusiness();
  const customers = new Map(
    (seed.customers ?? [makeCustomer()]).map((customer) => [customer.id, { ...customer }])
  );
  const suppliers = new Map(
    (seed.suppliers ?? [makeSupplier()]).map((supplier) => [supplier.id, { ...supplier }])
  );
  const products = new Map(
    (seed.products ?? [makeProduct()]).map((product) => [product.id, { ...product }])
  );
  const inventory = new Map(
    (seed.inventory ?? [makeInventory([...products.values()][0])]).map((entry) => [
      entry.productId,
      { ...entry, product: { ...entry.product } },
    ])
  );
  const state = {
    business,
    customers,
    suppliers,
    products,
    inventory,
    businessCounters: new Map(),
    sales: [],
    saleItems: [],
    invoices: [],
    cashMovements: (seed.cashMovements ?? []).map((movement) => ({ ...movement })),
    stockMovements: (seed.stockMovements ?? []).map((movement) => ({
      createdAt: movement.createdAt ?? new Date("2024-01-01T00:00:00.000Z"),
      ...movement,
    })),
    mockPurchaseRequests: [],
    criticalWriteEvents: [],
    idempotencyRecords: new Map(),
  };
  const calls = {
    saleCreate: 0,
    saleItemCreate: 0,
    invoiceCreate: 0,
    customerDeleteMany: 0,
    purchaseRequestInsert: 0,
    criticalWriteEventInsert: 0,
    whatsapp: 0,
  };

  const prisma = {
    state,
    calls,
    idempotencyRecord: {
      findFirst: async ({ where }) => {
        const key = `${where?.businessId}|${where?.actionType}|${where?.idempotencyKey}`;
        const record = state.idempotencyRecords.get(key);
        return record ? { ...record } : null;
      },
      create: async ({ data }) => {
        const key = `${data.businessId}|${data.actionType}|${data.idempotencyKey}`;
        if (state.idempotencyRecords.has(key)) {
          const error = new Error("Unique constraint failed on the fields");
          error.code = "P2002";
          throw error;
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
        for (const [key, record] of state.idempotencyRecords.entries()) {
          if (record.id !== where?.id) continue;
          const next = { ...record, ...data };
          state.idempotencyRecords.set(key, next);
          return { ...next };
        }
        throw new Error("IdempotencyRecord not found");
      },
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const [key, record] of state.idempotencyRecords.entries()) {
          const matchId = where?.id === undefined || record.id === where.id;
          const matchStatus = where?.status === undefined || record.status === where.status;
          const matchUpdatedAt =
            where?.updatedAt?.lt === undefined || (record.updatedAt && record.updatedAt < where.updatedAt.lt);
          const matchCompletedAt =
            where?.completedAt?.lt === undefined || (record.completedAt && record.completedAt < where.completedAt.lt);
          const matchBusinessId =
            where?.businessId === undefined || record.businessId === where.businessId;
          const matchActionType =
            where?.actionType === undefined || record.actionType === where.actionType;
          const matchResponseBody =
            where?.responseBody?.contains === undefined ||
            (typeof record.responseBody === "string" &&
              record.responseBody.includes(where.responseBody.contains));

          if (
            matchId &&
            matchStatus &&
            matchUpdatedAt &&
            matchCompletedAt &&
            matchBusinessId &&
            matchActionType &&
            matchResponseBody
          ) {
            state.idempotencyRecords.delete(key);
            count += 1;
          }
        }
        return { count };
      },
    },
    criticalWriteEvent: {
      create: async ({ data }) => {
        state.criticalWriteEvents.push({
          id: data.id,
          businessId: data.businessId,
          actorUserId: data.actorUserId,
          routeScope: data.routeScope,
          actionType: data.actionType,
          resourceType: data.resourceType,
          resourceId: data.resourceId,
          summary: data.summary,
          payloadJson: data.payloadJson,
          createdAt: data.createdAt,
        });
        calls.criticalWriteEventInsert += 1;
        return { id: data.id };
      },
      findFirst: async ({ where, orderBy, select } = {}) => {
        let events = state.criticalWriteEvents.filter((e) => {
          if (where?.businessId !== undefined && e.businessId !== where.businessId) return false;
          if (where?.actionType !== undefined && e.actionType !== where.actionType) return false;
          if (where?.resourceType !== undefined && e.resourceType !== where.resourceType) return false;
          if (where?.resourceId !== undefined && e.resourceId !== where.resourceId) return false;
          return true;
        });
        if (orderBy?.createdAt === "desc") {
          events = [...events].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        } else if (orderBy?.createdAt === "asc") {
          events = [...events].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        }
        const event = events[0];
        if (!event) return null;
        if (!select) return { ...event };
        const result = {};
        if (select.id) result.id = event.id;
        if (select.payloadJson) result.payloadJson = event.payloadJson;
        if (select.createdAt) result.createdAt = event.createdAt;
        if (select.actionType) result.actionType = event.actionType;
        if (select.resourceId) result.resourceId = event.resourceId;
        if (select.summary) result.summary = event.summary;
        return result;
      },
      findMany: async ({ where, orderBy, take, select } = {}) => {
        let events = state.criticalWriteEvents.filter((e) => {
          if (where?.businessId !== undefined && e.businessId !== where.businessId) return false;
          if (where?.actionType !== undefined && e.actionType !== where.actionType) return false;
          if (where?.resourceType !== undefined && e.resourceType !== where.resourceType) return false;
          if (where?.resourceId !== undefined && e.resourceId !== where.resourceId) return false;
          if (where?.createdAt?.gte !== undefined) {
            const cutoff = new Date(where.createdAt.gte).getTime();
            if (new Date(e.createdAt).getTime() < cutoff) return false;
          }
          return true;
        });
        if (orderBy?.createdAt === "desc") {
          events = [...events].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        } else if (orderBy?.createdAt === "asc") {
          events = [...events].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        }
        if (typeof take === "number") events = events.slice(0, take);
        if (!select) return events.map((e) => ({ ...e }));
        return events.map((e) => {
          const result = {};
          if (select.id) result.id = e.id;
          if (select.payloadJson) result.payloadJson = e.payloadJson;
          if (select.createdAt) result.createdAt = e.createdAt;
          if (select.actionType) result.actionType = e.actionType;
          if (select.resourceId) result.resourceId = e.resourceId;
          if (select.summary) result.summary = e.summary;
          return result;
        });
      },
    },
    business: {
      findUnique: async ({ where }) => {
        if (where?.userId && where.userId !== business.userId) return null;
        if (where?.id && where.id !== business.id) return null;
        return { ...business };
      },
      update: async ({ where, data }) => {
        if (where?.id !== business.id) {
          throw new Error("Business not found");
        }
        Object.assign(business, data);
        return { ...business };
      },
    },
    businessCounter: {
      upsert: async ({ where, update, create }) => {
        const counterType = where?.businessId_counterType?.counterType ?? create?.counterType;
        const businessId = where?.businessId_counterType?.businessId ?? create?.businessId ?? business.id;
        const key = `${businessId}|${counterType}`;
        const existing = state.businessCounters.get(key);

        if (existing) {
          const increment = Number(update?.value?.increment ?? 0);
          existing.value += increment;
          state.businessCounters.set(key, existing);
          return { value: existing.value };
        }

        const record = {
          id: create?.id ?? `counter-${state.businessCounters.size + 1}`,
          businessId,
          counterType,
          value: Number(create?.value ?? 1),
        };
        state.businessCounters.set(key, record);
        return { value: record.value };
      },
    },
    inventory: {
      findUnique: async ({ where }) => {
        const record = inventory.get(where?.productId);
        if (!record) return null;
        return {
          quantity: record.quantity,
          lastUpdated: record.lastUpdated,
          product: { ...record.product },
        };
      },
      updateMany: async ({ where, data }) => {
        const record = inventory.get(where?.productId);
        if (!record) return { count: 0 };

        const gte = where?.quantity?.gte;
        if (typeof gte === "number" && record.quantity < gte) {
          return { count: 0 };
        }

        if (data?.quantity && typeof data.quantity.decrement === "number") {
          record.quantity -= data.quantity.decrement;
        }

        if (data?.quantity && typeof data.quantity.increment === "number") {
          record.quantity += data.quantity.increment;
        }

        record.lastUpdated = new Date();
        inventory.set(where.productId, record);
        return { count: 1 };
      },
      upsert: async ({ where, update, create }) => {
        const productId = where?.productId ?? create?.productId;
        const existing = inventory.get(productId);
        const product = products.get(productId);

        if (existing) {
          if (typeof update?.quantity === "number") {
            existing.quantity = update.quantity;
          } else if (typeof update?.quantity?.increment === "number") {
            existing.quantity += update.quantity.increment;
          } else if (typeof update?.quantity?.decrement === "number") {
            existing.quantity -= update.quantity.decrement;
          }
          existing.lastUpdated = new Date();
          inventory.set(productId, existing);
          return { ...existing };
        }

        const record = {
          productId,
          quantity: create?.quantity ?? 0,
          lastUpdated: new Date(),
          product: product ? { ...product } : null,
        };
        inventory.set(productId, record);
        return { ...record };
      },
      create: async ({ data }) => {
        const product = products.get(data?.productId);
        const record = {
          productId: data?.productId,
          quantity: data?.quantity ?? 0,
          lastUpdated: new Date(),
          product: product ? { ...product } : null,
        };
        inventory.set(record.productId, record);
        return { ...record };
      },
      deleteMany: async ({ where }) => {
        const productId = where?.productId;
        if (!productId) return { count: 0 };
        return { count: inventory.delete(productId) ? 1 : 0 };
      },
    },
    customer: {
      findFirst: async ({ where }) => {
        let record = null;
        // Scalar id (optionally with businessId scope)
        if (typeof where?.id === "string") {
          const candidate = customers.get(where.id);
          if (candidate) {
            if (where.businessId === undefined || candidate.businessId === where.businessId) {
              record = candidate;
            }
          }
        } else if (where?.businessId_name?.name) {
          record = [...customers.values()].find(
            (c) => c.businessId === where.businessId_name.businessId && c.name === where.businessId_name.name
          );
        } else if (where?.businessId !== undefined && where?.name !== undefined) {
          // Unique-name check: businessId + name (+ optional id.not exclusion)
          record = [...customers.values()].find((c) => {
            if (c.businessId !== where.businessId) return false;
            if (c.name !== where.name) return false;
            if (where.id?.not !== undefined && c.id === where.id.not) return false;
            return true;
          });
        }
        return record ? { ...record } : null;
      },
      findUnique: async ({ where }) => {
        const record = customers.get(where?.id);
        return record ? { ...record } : null;
      },
      create: async ({ data }) => {
        const id = data?.id ?? `cust-${customers.size + 1}`;
        const record = makeCustomer({
          id,
          businessId: data?.businessId ?? business.id,
          name: data?.name ?? "Cliente",
          phone: data?.phone ?? null,
          email: data?.email ?? null,
          taxId: data?.taxId ?? null,
        });
        customers.set(record.id, record);
        return { ...record };
      },
      update: async ({ where, data }) => {
        const record = customers.get(where?.id);
        if (!record) {
          throw new Error("Customer not found");
        }
        Object.assign(record, data);
        customers.set(record.id, record);
        return { ...record };
      },
      upsert: async ({ where, create }) => {
        const key = where?.businessId_name?.name;
        let record = [...customers.values()].find(
          (customer) => customer.businessId === business.id && customer.name === key
        );
        if (!record) {
          record = makeCustomer({
            id: padId("cust", customers.size + 1),
            name: create?.name ?? key ?? "Consumidor Final",
            businessId: business.id,
          });
          customers.set(record.id, record);
        }
        return { ...record };
      },
      findMany: async () =>
        [...customers.values()]
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .map((customer) => ({
            id: customer.id,
            name: customer.name,
            _count: { sales: customer.salesCount ?? 0 },
          })),
      deleteMany: async ({ where }) => {
        calls.customerDeleteMany += 1;
        const ids = new Set(where?.id?.in ?? []);
        let deleted = 0;
        for (const id of ids) {
          if (customers.delete(id)) {
            deleted += 1;
          }
        }
        return { count: deleted };
      },
    },
    supplier: {
      findFirst: async ({ where }) => {
        if (where?.id) {
          const record = suppliers.get(where.id);
          if (!record || record.businessId !== business.id) return null;
          return { ...record };
        }

        const needle = String(where?.name?.contains ?? "").toLowerCase();
        const record = [...suppliers.values()].find(
          (supplier) => supplier.businessId === business.id && supplier.name.toLowerCase().includes(needle)
        );
        return record ? { ...record } : null;
      },
      create: async ({ data }) => {
        const record = makeSupplier({
          id: data?.id ?? padId("sup", suppliers.size + 1),
          businessId: data?.businessId ?? business.id,
          name: data?.name ?? "Proveedor",
          phone: data?.phone ?? null,
          email: data?.email ?? null,
          contactName: data?.contactName ?? null,
          leadTimeDays: data?.leadTimeDays ?? 3,
        });
        suppliers.set(record.id, record);
        return { ...record };
      },
      updateMany: async ({ where = {}, data = {} } = {}) => {
        let count = 0;
        for (const supplier of suppliers.values()) {
          if (where.id !== undefined && supplier.id !== where.id) continue;
          if (where.businessId !== undefined && supplier.businessId !== where.businessId) continue;
          Object.assign(supplier, data);
          count += 1;
        }
        return { count };
      },
      findMany: async ({ where } = {}) => {
        let list = [...suppliers.values()].filter(
          (supplier) => supplier.businessId === (where?.businessId ?? business.id)
        );
        if (where?.id?.in !== undefined) {
          const ids = new Set(where.id.in);
          list = list.filter((s) => ids.has(s.id));
        } else if (where?.id !== undefined) {
          list = list.filter((s) => s.id === where.id);
        }
        return list
          .sort((left, right) => left.name.localeCompare(right.name))
          .map((supplier) => ({ ...supplier }));
      },
      deleteMany: async ({ where = {} } = {}) => {
        const before = suppliers.size;
        const toDelete = [];
        for (const supplier of suppliers.values()) {
          if (where.businessId !== undefined && supplier.businessId !== where.businessId) continue;
          if (where.id?.in !== undefined) {
            if (!where.id.in.includes(supplier.id)) continue;
          } else if (where.id !== undefined && supplier.id !== where.id) continue;
          toDelete.push(supplier.id);
        }
        for (const id of toDelete) suppliers.delete(id);
        return { count: before - suppliers.size };
      },
    },
    product: {
      findUnique: async ({ where, select }) => {
        const record = products.get(where?.id);
        if (!record) return null;
        if (where?.businessId !== undefined && record.businessId !== where.businessId) return null;
        if (!select) return { ...record };
        const out = {};
        for (const k of Object.keys(select)) if (select[k]) out[k] = record[k] ?? null;
        return out;
      },
      findFirst: async ({ where }) => {
        let record = null;

        const idParam = where?.id || (where?.AND && where.AND.find((c) => c.id)?.id);
        const businessIdParam = where?.businessId || (where?.AND && where.AND.find((c) => c.businessId)?.businessId);
        const nameContainsParam = where?.name?.contains || (where?.AND && where.AND.find((c) => c.name?.contains)?.name?.contains);

        if (idParam) {
          const candidate = products.get(idParam);
          if (candidate && (!businessIdParam || candidate.businessId === businessIdParam)) {
            record = candidate;
          }
        }

        if (!record && nameContainsParam) {
          const needle = String(nameContainsParam).toLowerCase();
          record =
            [...products.values()].find(
              (product) =>
                product.businessId === (businessIdParam ?? business.id) &&
                product.name.toLowerCase().includes(needle)
            ) ?? null;
        }

        if (!record) return null;
        const inventoryRecord = inventory.get(record.id);

        return {
          ...record,
          inventory: inventoryRecord ? { quantity: inventoryRecord.quantity } : null,
          _count: {
            saleItems: state.saleItems.filter((item) => item.productId === record.id).length,
            stockMovements: state.stockMovements.filter((movement) => movement.productId === record.id).length,
          },
        };
      },
      findMany: async ({ where, orderBy } = {}) => {
        const businessIdParam = where?.businessId || (where?.AND && where.AND.find((c) => c.businessId)?.businessId);
        return [...products.values()]
          .filter((product) => product.businessId === (businessIdParam ?? business.id))
          .sort((left, right) =>
            orderBy?.name === "asc" ? left.name.localeCompare(right.name) : 0
          )
          .map((product) => {
            const inventoryRecord = inventory.get(product.id);
            return {
              ...product,
              inventory: inventoryRecord ? { quantity: inventoryRecord.quantity } : null,
            };
          });
      },
      create: async ({ data }) => {
        const record = makeProduct({
          id: data?.id ?? `prod-${products.size + 1}`,
          businessId: data?.businessId ?? business.id,
          name: data?.name ?? "Producto",
          price: data?.price ?? 0,
          costPrice: data?.costPrice ?? null,
          sku: data?.sku ?? null,
          quantity: data?.quantity ?? 0,
        });
        products.set(record.id, record);
        return { ...record };
      },
      update: async ({ where, data }) => {
        const record = products.get(where?.id);
        if (!record) {
          throw new Error("Product not found");
        }
        // Handle Prisma atomic operations ({ increment: N } / { decrement: N })
        // on numeric fields so undo handlers work correctly.
        const resolved = { ...data };
        for (const [key, val] of Object.entries(resolved)) {
          if (val !== null && typeof val === "object") {
            if (typeof val.increment === "number") {
              resolved[key] = (record[key] ?? 0) + val.increment;
            } else if (typeof val.decrement === "number") {
              resolved[key] = (record[key] ?? 0) - val.decrement;
            }
          }
        }
        Object.assign(record, resolved);
        products.set(record.id, record);
        return { ...record };
      },
      updateMany: async ({ where = {}, data = {} } = {}) => {
        // Used by sale-inventory.ts to atomically decrement stock.
        let count = 0;
        for (const product of products.values()) {
          if (where.id !== undefined && product.id !== where.id) continue;
          if (where.businessId !== undefined && product.businessId !== where.businessId) continue;
          if (where.quantity?.gte !== undefined && (product.quantity ?? 0) < where.quantity.gte) continue;
          // Apply updates
          const resolved = { ...data };
          for (const [key, val] of Object.entries(resolved)) {
            if (val !== null && typeof val === "object") {
              if (typeof val.increment === "number") resolved[key] = (product[key] ?? 0) + val.increment;
              else if (typeof val.decrement === "number") resolved[key] = (product[key] ?? 0) - val.decrement;
            }
          }
          Object.assign(product, resolved);
          products.set(product.id, product);
          count += 1;
        }
        return { count };
      },
      delete: async ({ where }) => {
        const existing = products.get(where?.id);
        products.delete(where?.id);
        return existing ? { ...existing } : null;
      },
      deleteMany: async ({ where = {} } = {}) => {
        const before = products.size;
        const toDelete = [];
        for (const product of products.values()) {
          if (where.id?.in !== undefined) {
            if (!where.id.in.includes(product.id)) continue;
          } else if (where.id !== undefined && product.id !== where.id) continue;
          if (where.businessId !== undefined && product.businessId !== where.businessId) continue;
          toDelete.push(product.id);
        }
        for (const id of toDelete) products.delete(id);
        return { count: before - products.size };
      },
    },
    sale: {
      create: async ({ data }) => {
        calls.saleCreate += 1;
        const record = {
          id: padId("sale", state.sales.length + 1),
          customerId: data?.customerId ?? null,
          date: data?.date ?? new Date(),
          totalAmount: data?.totalAmount ?? 0,
          taxAmount: data?.taxAmount ?? 0,
          status: data?.status ?? "completed",
          businessId: data?.businessId ?? business.id,
        };
        state.sales.push(record);
        const customer = customers.get(record.customerId);
        if (customer) {
          customer.salesCount = (customer.salesCount ?? 0) + 1;
        }
        return { ...record };
      },
      findFirst: async ({ where, select } = {}) => {
        let record = null;
        for (const sale of state.sales) {
          if (where?.id !== undefined && sale.id !== where.id) continue;
          if (where?.businessId !== undefined && sale.businessId !== where.businessId) continue;
          record = sale;
          break;
        }
        if (!record) return null;
        if (!select) return { ...record };
        const out = {};
        if (select.id) out.id = record.id;
        if (select.totalAmount) out.totalAmount = record.totalAmount;
        if (select.status) out.status = record.status;
        if (select.customerId) out.customerId = record.customerId;
        if (select.businessId) out.businessId = record.businessId;
        return out;
      },
      update: async ({ where, data }) => {
        const sale = state.sales.find((s) => s.id === where?.id);
        if (!sale) throw new Error("Sale not found");
        if (data?.status !== undefined) sale.status = data.status;
        return { ...sale };
      },
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const sale of state.sales) {
          if (where?.id !== undefined && sale.id !== where.id) continue;
          if (where?.businessId !== undefined && sale.businessId !== where.businessId) continue;
          if (where?.status !== undefined && sale.status !== where.status) continue;
          if (data?.status !== undefined) sale.status = data.status;
          count += 1;
        }
        return { count };
      },
      delete: async ({ where }) => {
        state.sales = state.sales.filter((sale) => sale.id !== where?.id);
      },
      deleteMany: async ({ where = {} } = {}) => {
        const before = state.sales.length;
        state.sales = state.sales.filter((sale) => {
          if (where.id !== undefined && sale.id !== where.id) return true;
          if (where.businessId !== undefined && sale.businessId !== where.businessId) return true;
          return false;
        });
        return { count: before - state.sales.length };
      },
      findMany: async ({ where, orderBy, take, select } = {}) => {
        let sales = [...state.sales];
        if (where?.businessId !== undefined) {
          sales = sales.filter((s) => s.businessId === where.businessId);
        }
        if (where?.date?.gte !== undefined) {
          const cutoff = new Date(where.date.gte).getTime();
          sales = sales.filter((s) => new Date(s.date).getTime() >= cutoff);
        }
        if (orderBy?.date === "desc") {
          sales.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        } else if (orderBy?.date === "asc") {
          sales.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        }
        if (typeof take === "number") {
          sales = sales.slice(0, take);
        }
        if (!select) return sales.map((sale) => ({ ...sale }));
        return sales.map((sale) => {
          const result = {};
          if (select.id) result.id = sale.id;
          if (select.date) result.date = sale.date;
          if (select.totalAmount) result.totalAmount = sale.totalAmount;
          if (select.customer) {
            const customer = customers.get(sale.customerId);
            result.customer = customer ? { name: customer.name } : null;
          }
          if (select.saleItems) {
            result.saleItems = state.saleItems
              .filter((item) => item.saleId === sale.id)
              .map((item) => ({ productId: item.productId, quantity: item.quantity }));
          }
          return result;
        });
      },
    },
    saleItem: {
      create: async ({ data }) => {
        calls.saleItemCreate += 1;
        state.saleItems.push({ ...data });
        return { ...data };
      },
      deleteMany: async ({ where }) => {
        const before = state.saleItems.length;
        state.saleItems = state.saleItems.filter((item) => item.saleId !== where?.saleId);
        return { count: before - state.saleItems.length };
      },
      findMany: async ({ where } = {}) => {
        let items = [...state.saleItems];
        if (where?.saleId !== undefined) {
          items = items.filter((item) => item.saleId === where.saleId);
        }
        return items.map((item) => ({ ...item }));
      },
      count: async ({ where } = {}) => {
        let items = state.saleItems;
        if (where?.productId !== undefined) {
          items = items.filter((item) => item.productId === where.productId);
        }
        if (where?.saleId !== undefined) {
          items = items.filter((item) => item.saleId === where.saleId);
        }
        return items.length;
      },
    },
    invoice: {
      count: async () => state.invoices.length,
      findFirst: async ({ where }) => {
        const { businessId, documentType } = where || {};
        const matches = state.invoices
          .filter(
            (inv) =>
              inv.businessId === businessId && inv.documentType === documentType
          )
          .sort((a, b) => (b.sequenceNumber || 0) - (a.sequenceNumber || 0));
        return matches[0] ? { ...matches[0] } : null;
      },
      create: async ({ data }) => {
        calls.invoiceCreate += 1;
        const record = {
          id: padId("invoice", state.invoices.length + 1),
          businessId: data?.businessId ?? business.id,
          saleId: data?.saleId ?? null,
          invoiceNumber: data?.invoiceNumber ?? "",
          issuedAt: data?.issuedAt ?? new Date(),
          currency: data?.currency ?? business.currency,
          totalAmount: data?.totalAmount ?? 0,
          payloadJson: data?.payloadJson ?? "{}",
          // New fields for fiscal logic
          documentType: data?.documentType ?? "receipt",
          sequenceNumber: data?.sequenceNumber ?? 0,
        };
        state.invoices.push(record);
        return { ...record };
      },
      deleteMany: async ({ where }) => {
        const before = state.invoices.length;
        state.invoices = state.invoices.filter((invoice) => invoice.saleId !== where?.saleId);
        return { count: before - state.invoices.length };
      },
      findMany: async ({ where } = {}) => {
        let invoices = [...state.invoices];
        if (where?.saleId?.in !== undefined) {
          const ids = new Set(where.saleId.in);
          invoices = invoices.filter((inv) => ids.has(inv.saleId));
        } else if (where?.saleId !== undefined) {
          invoices = invoices.filter((inv) => inv.saleId === where.saleId);
        }
        if (where?.status?.in !== undefined) {
          const statuses = new Set(where.status.in);
          invoices = invoices.filter((inv) => statuses.has(inv.status));
        } else if (where?.status !== undefined) {
          invoices = invoices.filter((inv) => inv.status === where.status);
        }
        return invoices.map((inv) => ({ ...inv }));
      },
    },
    cashMovement: {
      create: async ({ data }) => {
        const record = {
          id: padId("movement", state.cashMovements.length + 1),
          businessId: data?.businessId ?? business.id,
          saleId: data?.saleId ?? null,
          type: data?.type ?? "purchase",
          description: data?.description ?? "",
          amount: data?.amount ?? 0,
          date: data?.date ?? new Date().toISOString(),
          createdAt: new Date().toISOString(),
        };
        state.cashMovements.push(record);
        return { ...record };
      },
      findMany: async ({ where, orderBy, take, select } = {}) => {
        let movements = state.cashMovements.filter((m) => {
          if (where?.businessId !== undefined && m.businessId !== where.businessId) return false;
          if (where?.saleId === null) {
            if (m.saleId !== null) return false;
          } else if (where?.saleId !== undefined && m.saleId !== where.saleId) return false;
          if (where?.createdAt?.gte !== undefined) {
            const cutoff = new Date(where.createdAt.gte).getTime();
            if (new Date(m.createdAt).getTime() < cutoff) return false;
          }
          return true;
        });
        if (orderBy?.createdAt === "desc") {
          movements = [...movements].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
          );
        } else if (orderBy?.createdAt === "asc") {
          movements = [...movements].sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
          );
        }
        if (typeof take === "number") movements = movements.slice(0, take);
        if (!select) return movements.map((m) => ({ ...m }));
        return movements.map((m) => {
          const result = {};
          if (select.id) result.id = m.id;
          if (select.description) result.description = m.description;
          if (select.amount) result.amount = m.amount;
          if (select.businessId) result.businessId = m.businessId;
          if (select.saleId) result.saleId = m.saleId;
          if (select.createdAt) result.createdAt = m.createdAt;
          return result;
        });
      },
      deleteMany: async ({ where = {} } = {}) => {
        const before = state.cashMovements.length;
        state.cashMovements = state.cashMovements.filter((movement) => {
          if (where.id?.in !== undefined) {
            if (!where.id.in.includes(movement.id)) return true;
          } else if (where.id !== undefined && movement.id !== where.id) return true;
          if (where.businessId !== undefined && movement.businessId !== where.businessId) return true;
          if (where.saleId === null) {
            if (movement.saleId !== null) return true;
          } else if (where.saleId !== undefined && movement.saleId !== where.saleId) return true;
          return false;
        });
        return { count: before - state.cashMovements.length };
      },
    },
    purchaseRequest: {
      create: async ({ data }) => {
        const record = {
          id: data?.id ?? `purchase-${state.mockPurchaseRequests.length + 1}`,
          businessId: data?.businessId ?? business.id,
          supplierId: data?.supplierId ?? null,
          requestNumber: data?.requestNumber ?? "",
          issuedAt: data?.issuedAt ?? new Date(),
          currency: data?.currency ?? business.currency,
          totalAmount: data?.totalAmount ?? 0,
          payloadJson: data?.payloadJson ?? "{}",
          createdAt: data?.createdAt ?? new Date(),
        };
        state.mockPurchaseRequests.push(record);
        calls.purchaseRequestInsert += 1;
        return { ...record };
      },
      findMany: async ({ where } = {}) => {
        return state.mockPurchaseRequests
          .filter((request) => (where?.businessId ? request.businessId === where.businessId : true))
          .map((request) => ({ ...request }));
      },
    },
    // policy-evaluator.ts calls these two models via enforcePolicy.
    // Return empty arrays so the evaluator treats every action as allowed
    // (no rules, no delegation policies active in test scope).
    businessRule: {
      findMany: async () => [],
    },
    delegationPolicy: {
      findMany: async () => [],
    },
    stockMovement: {
      create: async ({ data }) => {
        const record = {
          id: padId("stock", state.stockMovements.length + 1),
          createdAt: new Date(),
          ...data,
        };
        state.stockMovements.push(record);
        return { ...record };
      },
      findMany: async ({ where, orderBy, take } = {}) => {
        let movements = [...state.stockMovements];

        if (where?.businessId) {
          movements = movements.filter((movement) => movement.businessId === where.businessId);
        }
        if (where?.reason) {
          movements = movements.filter((movement) => movement.reason === where.reason);
        }
        if (where?.delta?.gt !== undefined) {
          movements = movements.filter((movement) => movement.delta > where.delta.gt);
        }
        if (where?.createdAt?.gte) {
          const cutoff = new Date(where.createdAt.gte).getTime();
          movements = movements.filter((movement) => new Date(movement.createdAt).getTime() >= cutoff);
        }
        if (where?.id?.in) {
          const ids = new Set(where.id.in);
          movements = movements.filter((movement) => ids.has(movement.id));
        }
        if (orderBy?.createdAt === "desc") {
          movements.sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
        }
        if (typeof take === "number") {
          movements = movements.slice(0, take);
        }

        return movements.map((movement) => ({ ...movement }));
      },
      delete: async ({ where }) => {
        const index = state.stockMovements.findIndex((movement) => movement.id === where?.id);
        if (index === -1) return null;
        const [removed] = state.stockMovements.splice(index, 1);
        return { ...removed };
      },
      deleteMany: async ({ where } = {}) => {
        const before = state.stockMovements.length;
        if (where?.productId) {
          state.stockMovements = state.stockMovements.filter((m) => m.productId !== where.productId);
        } else if (where?.referenceId !== undefined || where?.reason !== undefined) {
          state.stockMovements = state.stockMovements.filter((m) => {
            if (where?.referenceId !== undefined && m.referenceId !== where.referenceId) return true;
            if (where?.reason !== undefined && m.reason !== where.reason) return true;
            return false;
          });
        }
        return { count: before - state.stockMovements.length };
      },
    },
    $transaction: async (callback) => callback(prisma),
    $queryRawUnsafe: async (query, ...params) => {
      const sql = String(query);

      if (sql.includes("FROM IdempotencyRecord")) {
        const [businessId, actionType, idempotencyKey] = params;
        const record = state.idempotencyRecords.get(
          `${businessId}|${actionType}|${idempotencyKey}`
        );
        return record ? [{ ...record }] : [];
      }

      if (sql.includes("FROM Business WHERE id = ?")) {
        return [
          {
            cuit: business.cuit ?? null,
            address: business.address ?? null,
            whatsappPhone: business.whatsappPhone ?? null,
            ivaCondition: business.ivaCondition ?? null,
            puntoVenta: business.puntoVenta ?? null,
            iibb: business.iibb ?? null,
            activityStart: business.activityStart ?? null,
          },
        ];
      }

      if (sql.includes("SELECT requestNumber FROM MockPurchaseRequest WHERE businessId = ?")) {
        const [businessId] = params;
        return state.mockPurchaseRequests
          .filter((entry) => entry.businessId === businessId)
          .map((entry) => ({ requestNumber: entry.requestNumber }));
      }

      if (sql.includes("SELECT id FROM CashMovement WHERE businessId = ? AND saleId = ? LIMIT 1")) {
        const [businessId, saleId] = params;
        const record = state.cashMovements.find(
          (movement) => movement.businessId === businessId && movement.saleId === saleId
        );
        return record ? [{ id: record.id }] : [];
      }

      if (sql.includes("SELECT id, description, amount, date FROM CashMovement")) {
        return state.cashMovements.map((movement) => ({
          id: movement.id,
          description: movement.description,
          amount: movement.amount,
          date: movement.date,
        }));
      }

      return [];
    },
    $executeRawUnsafe: async (query, ...params) => {
      const sql = String(query);

      if (sql.startsWith("INSERT INTO IdempotencyRecord")) {
        const [id, businessId, actionType, idempotencyKey, requestHash, , createdAt, updatedAt] = params;
        const key = `${businessId}|${actionType}|${idempotencyKey}`;
        if (state.idempotencyRecords.has(key)) {
          const error = new Error(
            "UNIQUE constraint failed: IdempotencyRecord.businessId, IdempotencyRecord.actionType, IdempotencyRecord.idempotencyKey"
          );
          throw error;
        }
        state.idempotencyRecords.set(key, {
          id,
          businessId,
          actionType,
          idempotencyKey,
          requestHash,
          status: "pending",
          responseStatus: null,
          responseBody: null,
          createdAt,
          updatedAt,
          completedAt: null,
        });
        return 1;
      }

      if (sql.startsWith("UPDATE IdempotencyRecord")) {
        const [responseStatus, responseBody, completedAt, updatedAt, id] = params;
        for (const record of state.idempotencyRecords.values()) {
          if (record.id === id) {
            record.status = "completed";
            record.responseStatus = responseStatus;
            record.responseBody = responseBody;
            record.completedAt = completedAt;
            record.updatedAt = updatedAt;
          }
        }
        return 1;
      }

      if (sql.startsWith("DELETE FROM IdempotencyRecord")) {
        const [id] = params;
        for (const [key, record] of state.idempotencyRecords.entries()) {
          if (record.id === id && record.status === "pending") {
            state.idempotencyRecords.delete(key);
          }
        }
        return 1;
      }

      if (sql.startsWith("INSERT INTO CashMovement")) {
        const [id, businessId, saleId, type, description, amount, date, createdAt] = params;
        state.cashMovements.push({
          id,
          businessId,
          saleId,
          type,
          description,
          amount,
          date,
          createdAt,
        });
        return 1;
      }

      if (sql.startsWith("DELETE FROM CashMovement")) {
        const [id] = params;
        state.cashMovements = state.cashMovements.filter((movement) => movement.id !== id);
        return 1;
      }

      if (sql.startsWith("INSERT INTO MockPurchaseRequest")) {
        const [id, businessId, supplierId, requestNumber, issuedAt, currency, totalAmount, payloadJson, createdAt] = params;
        state.mockPurchaseRequests.push({
          id,
          businessId,
          supplierId,
          requestNumber,
          issuedAt,
          currency,
          totalAmount,
          payloadJson,
          createdAt,
        });
        calls.purchaseRequestInsert += 1;
        return 1;
      }

      if (sql.startsWith("INSERT INTO CriticalWriteEvent")) {
        const [id, businessId, actorUserId, routeScope, actionType, resourceType, resourceId, summary, payloadJson, createdAt] = params;
        state.criticalWriteEvents.push({
          id,
          businessId,
          actorUserId,
          routeScope,
          actionType,
          resourceType,
          resourceId,
          summary,
          payloadJson,
          createdAt,
        });
        calls.criticalWriteEventInsert += 1;
        return 1;
      }

      if (
        sql.startsWith("CREATE TABLE IF NOT EXISTS CriticalWriteEvent") ||
        sql.startsWith("CREATE INDEX IF NOT EXISTS idx_critical_write_event_business_action_created")
      ) {
        return 1;
      }

      return 1;
    },
  };

  return prisma;
}

function loadRoute(routeRelativePath, mocks) {
  resetSourceModules();
  clearMockModules();

  for (const [request, exports] of Object.entries(mocks)) {
    setMockModule(request, exports);
  }

  return require(path.join(process.cwd(), routeRelativePath));
}

// ── documentType truth model verification ────────────────────────────────────

test("sales/create emits receipt when CUIT is missing", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness({ name: "Velora", cuit: null, ivaCondition: "Monotributista" }),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa" })],
    products: [makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 10 })],
    inventory: [],
  });
  const route = loadRoute("src/app/api/sales/create/route.ts", makeModuleMocks({ prisma }));
  const res = await route.POST(makeRequest({
    customerId: "cust1aaaaaaaaaaaaaaaaaaa",
    items: [{ productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 1, unitPrice: 100 }],
    total: 100,
    locale: "es-419",
  }, "key-receipt-cuit-missing"));
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.invoice.documentType, "receipt", "missing CUIT must produce receipt");
  assert.ok(json.invoice.invoiceNumber.startsWith("REC-"), `invoiceNumber should start with REC-, got: ${json.invoice.invoiceNumber}`);
});

test("sales/create emits receipt when IVA condition is missing", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness({ name: "Velora", cuit: "20-12345678-9", ivaCondition: null }),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa" })],
    products: [makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 10 })],
    inventory: [],
  });
  const route = loadRoute("src/app/api/sales/create/route.ts", makeModuleMocks({ prisma }));
  const res = await route.POST(makeRequest({
    customerId: "cust1aaaaaaaaaaaaaaaaaaa",
    items: [{ productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 1, unitPrice: 100 }],
    total: 100,
    locale: "es-419",
  }, "key-receipt-iva-missing"));
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.invoice.documentType, "receipt", "missing ivaCondition must produce receipt");
  assert.ok(json.invoice.invoiceNumber.startsWith("REC-"), `invoiceNumber should start with REC-, got: ${json.invoice.invoiceNumber}`);
});

test("sales/create emits receipt when business name is blank", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness({ name: "", cuit: "20-12345678-9", ivaCondition: "Monotributista" }),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa" })],
    products: [makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 10 })],
    inventory: [],
  });
  const route = loadRoute("src/app/api/sales/create/route.ts", makeModuleMocks({ prisma }));
  const res = await route.POST(makeRequest({
    customerId: "cust1aaaaaaaaaaaaaaaaaaa",
    items: [{ productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 1, unitPrice: 100 }],
    total: 100,
    locale: "es-419",
  }, "key-receipt-name-blank"));
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.invoice.documentType, "receipt", "blank name must produce receipt");
  assert.ok(json.invoice.invoiceNumber.startsWith("REC-"), `invoiceNumber should start with REC-, got: ${json.invoice.invoiceNumber}`);
});

test("sales/create emits invoice when name + CUIT + IVA condition are all present", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness({ name: "Velora SRL", cuit: "30-71234567-8", ivaCondition: "Monotributista" }),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa" })],
    products: [makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 10 })],
    inventory: [],
  });
  const route = loadRoute("src/app/api/sales/create/route.ts", makeModuleMocks({ prisma }));
  const res = await route.POST(makeRequest({
    customerId: "cust1aaaaaaaaaaaaaaaaaaa",
    items: [{ productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 1, unitPrice: 100 }],
    total: 100,
    locale: "es-419",
  }, "key-invoice-complete"));
  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.invoice.documentType, "invoice", "complete fiscal data must produce invoice");
  assert.ok(json.invoice.invoiceNumber.startsWith("FC-"), `invoiceNumber should start with FC-, got: ${json.invoice.invoiceNumber}`);
});

test("sales/create venta sin customerId crea con Consumidor Final como cliente y retorna 201", async () => {
  // Política: cuando no viene customerId (venta al paso), el server crea/
  // resuelve un cliente "Consumidor Final" del business y le asocia la venta.
  // El cliente NO debe existir previamente — el handler lo crea on-demand.
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [], // empieza vacío — el cliente "Consumidor Final" debe nacer aquí
    products: [makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Galletitas", quantity: 10 })],
    inventory: [],
  });
  const route = loadRoute("src/app/api/sales/create/route.ts", makeModuleMocks({ prisma }));
  const res = await route.POST(makeRequest({
    // customerId DELIBERADAMENTE ausente
    items: [{ productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 2, unitPrice: 100 }],
    total: 200,
    locale: "es-419",
  }, "key-no-customer"));

  assert.equal(res.status, 201);
  const json = await res.json();
  assert.ok(json.sale, "venta debe haberse creado");
  assert.equal(prisma.calls.saleCreate, 1);

  // El cliente "Consumidor Final" debe existir ahora en el business
  const created = [...prisma.state.customers.values()].find(
    (c) => c.businessId === "biz1aaaaaaaaaaaaaaaaaaaa" && c.name === "Consumidor Final"
  );
  assert.ok(created, "Consumidor Final debe haber sido creado on-demand");

  // Replay con la misma idempotency key → mismo resultado, sin crear segundo cliente
  const replay = await route.POST(makeRequest({
    items: [{ productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 2, unitPrice: 100 }],
    total: 200,
    locale: "es-419",
  }, "key-no-customer"));
  assert.equal(replay.status, 201);
  const consumidoresFinales = [...prisma.state.customers.values()].filter(
    (c) => c.businessId === "biz1aaaaaaaaaaaaaaaaaaaa" && c.name === "Consumidor Final"
  );
  assert.equal(consumidoresFinales.length, 1, "no debe duplicar Consumidor Final en replays");
});

// ─────────────────────────────────────────────────────────────────────────────

test("sales/create replays a duplicate submit without creating a second sale", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness({ whatsappPhone: null }),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa", name: "Acme", salesCount: 0 })],
    products: [makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", reorderThreshold: 5, quantity: 10 })],
    inventory: [],
  });

  const route = loadRoute("src/app/api/sales/create/route.ts", makeModuleMocks({ prisma }));
  const body = {
    customerId: "cust1aaaaaaaaaaaaaaaaaaa",
    items: [{ productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 2, unitPrice: 100 }],
    total: 200,
    locale: "es-419",
  };

  const first = await route.POST(makeRequest(body, "sale-key-clean"));
  assert.equal(first.status, 201);
  const firstJson = await first.json();
  assert.equal(firstJson.sale.id, "sale1aaaaaaaaaaaaaaaaaaa");
  assert.equal(prisma.calls.saleCreate, 1);
  assert.equal(prisma.calls.invoiceCreate, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);

  const second = await route.POST(makeRequest(body, "sale-key-clean"));
  assert.equal(second.status, 201);
  const secondJson = await second.json();

  assert.deepEqual(secondJson, firstJson);
  assert.equal(prisma.calls.saleCreate, 1);
  assert.equal(prisma.state.sales.length, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("sales/create keeps replay safety even if post-commit WhatsApp notification fails", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness({ whatsappPhone: "5491112345678" }),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa", name: "Acme", salesCount: 0 })],
    products: [makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", reorderThreshold: 5, quantity: 6 })],
    inventory: [],
  });

  let whatsappCalls = 0;
  const route = loadRoute(
    "src/app/api/sales/create/route.ts",
    makeModuleMocks({
      prisma,
      sendWhatsAppMessage: async () => {
        whatsappCalls += 1;
        throw new Error("whatsapp failed");
      },
    })
  );

  const body = {
    customerId: "cust1aaaaaaaaaaaaaaaaaaa",
    items: [{ productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 2, unitPrice: 100 }],
    total: 200,
    locale: "es-419",
  };

  const first = await route.POST(makeRequest(body, "sale-key-failure"));
  assert.equal(first.status, 201);
  assert.equal(prisma.calls.saleCreate, 1);
  assert.equal(whatsappCalls, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);

  const record = prisma.state.idempotencyRecords.get(
    "biz1aaaaaaaaaaaaaaaaaaaa|sale.create|sale-key-failure"
  );
  assert.ok(record);
  assert.equal(record.status, "completed");
  assert.equal(record.responseStatus, 201);

  const second = await route.POST(makeRequest(body, "sale-key-failure"));
  assert.equal(second.status, 201);
  const secondJson = await second.json();

  assert.equal(secondJson.sale.id, "sale1aaaaaaaaaaaaaaaaaaa");
  assert.equal(prisma.calls.saleCreate, 1);
  assert.equal(prisma.state.sales.length, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("sales/create concurrent submits with same idempotency key — exactly one sale, no double charge", async () => {
  // SEC-CONCURRENCY: dos POSTs en flight al mismo tiempo con la misma key.
  // En el flujo real (Postgres), la unique constraint sobre
  // (businessId, actionType, idempotencyKey) garantiza que sólo uno gana
  // el insert; el otro recibe P2002 y cae al path de replay/conflict.
  // El fake Prisma reproduce el constraint atómicamente vía Map.has/set
  // entre awaits, lo que ejerce exactamente el mismo branch.
  //
  // Garantías que el test documenta:
  //   - calls.saleCreate === 1            (no double charge)
  //   - state.sales.length === 1          (no fila duplicada)
  //   - criticalWriteEvents.length === 1  (no audit duplicado)
  //   - al menos una respuesta exitosa
  //   - la segunda llega como replay (200, body idéntico) o conflict (409
  //     "in_flight") según el orden de await — ambos son aceptables.
  const prisma = createFakePrisma({
    business: makeBusiness({ whatsappPhone: null }),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa", name: "Acme", salesCount: 0 })],
    products: [makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", reorderThreshold: 5, quantity: 10 })],
    inventory: [],
  });

  const route = loadRoute("src/app/api/sales/create/route.ts", makeModuleMocks({ prisma }));
  const body = {
    customerId: "cust1aaaaaaaaaaaaaaaaaaa",
    items: [{ productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 2, unitPrice: 100 }],
    total: 200,
    locale: "es-419",
  };

  const [resA, resB] = await Promise.all([
    route.POST(makeRequest(body, "sale-key-concurrent")),
    route.POST(makeRequest(body, "sale-key-concurrent")),
  ]);

  // Garantía dura: nunca se ejecuta sale.create dos veces.
  assert.equal(prisma.calls.saleCreate, 1, "exactly one sale row created");
  assert.equal(prisma.state.sales.length, 1, "exactly one sale persisted");
  assert.equal(prisma.state.criticalWriteEvents.length, 1, "exactly one audit event");

  // Al menos una respuesta exitosa con la venta.
  const successes = [resA, resB].filter((r) => r.status === 201);
  assert.ok(successes.length >= 1, "at least one POST returned 201");

  // La otra respuesta es replay (200 idéntico) o conflict 409 (in_flight).
  const others = [resA, resB].filter((r) => r !== successes[0]);
  for (const r of others) {
    assert.ok(
      r.status === 201 || r.status === 409,
      `loser status must be 201 (replay) or 409 (in_flight), got ${r.status}`
    );
  }
});

test("sales/create rejects a product that belongs to another business", async () => {
  const foreignProduct = makeProduct({ id: "prodforeignaaaaaaaaaaaaa", businessId: "biz2aaaaaaaaaaaaaaaaaaaa", name: "Foreign Widget", quantity: 10 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [foreignProduct],
    inventory: [],
  });

  const route = loadRoute("src/app/api/sales/create/route.ts", makeModuleMocks({ prisma }));
  const body = {
    customerId: "cust1aaaaaaaaaaaaaaaaaaa",
    items: [{ productId: "prodforeignaaaaaaaaaaaaa", quantity: 1, unitPrice: 100 }],
    total: 100,
    locale: "es-419",
  };

  const response = await route.POST(makeRequest(body, "sale-key-foreign-product"));
  // Pre-transaction check (FINDING #9) rejects unknown/foreign products
  // with 422 "entity-deleted" before any DB write is attempted. The
  // in-transaction PRODUCT_NOT_OWNED 400 branch remains as TOCTOU defense.
  assert.equal(response.status, 422);
  const json = await response.json();
  assert.equal(json.code, "ENTITY_DELETED");
  assert.deepEqual(json.missing, ["prodforeignaaaaaaaaaaaaa"]);
  assert.equal(prisma.calls.saleCreate, 0);
  assert.equal(prisma.calls.invoiceCreate, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("purchase-requests replays a duplicate submit without creating a second request", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    suppliers: [makeSupplier({ id: "sup1aaaaaaaaaaaaaaaaaaaa", name: "Paper Co" })],
  });

  const route = loadRoute("src/app/api/purchase-requests/route.ts", makeModuleMocks({ prisma }));
  const body = {
    supplierId: "sup1aaaaaaaaaaaaaaaaaaaa",
    supplierName: "Paper Co",
    itemName: "Paper",
    quantity: 3,
    unitPrice: 10,
  };

  const first = await route.POST(makeRequest(body, "purchase-key-clean"));
  assert.equal(first.status, 201);
  const firstJson = await first.json();
  assert.equal(firstJson.request.requestNumber, "OC-000001");
  assert.equal(prisma.calls.purchaseRequestInsert, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);

  const second = await route.POST(makeRequest(body, "purchase-key-clean"));
  assert.equal(second.status, 201);
  const secondJson = await second.json();

  assert.deepEqual(secondJson, firstJson);
  assert.equal(prisma.calls.purchaseRequestInsert, 1);
  assert.equal(prisma.state.mockPurchaseRequests.length, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("purchase-requests rejects a supplier that belongs to another business", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    suppliers: [makeSupplier({ id: "supforeignaaaaaaaaaaaaaa", businessId: "biz2aaaaaaaaaaaaaaaaaaaa", name: "Foreign Paper Co" })],
  });

  const route = loadRoute("src/app/api/purchase-requests/route.ts", makeModuleMocks({ prisma }));
  const body = {
    supplierId: "supforeignaaaaaaaaaaaaaa",
    supplierName: "Foreign Paper Co",
    itemName: "Paper",
    quantity: 3,
    unitPrice: 10,
  };

  const response = await route.POST(makeRequest(body, "purchase-key-foreign-supplier"));
  assert.equal(response.status, 400);
  const json = await response.json();
  assert.equal(json.message, "Proveedor inválido para este negocio.");
  assert.equal(prisma.calls.purchaseRequestInsert, 0);
  assert.equal(prisma.state.mockPurchaseRequests.length, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("stock-loads replays a duplicate submit without duplicating stock, cash or audit events", async () => {
  // inventory model merged into Product.quantity; seed quantity on product directly.
  const product = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", price: 100, costPrice: 60, sku: "WIDGET", quantity: 10 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [product],
    inventory: [],
  });

  const route = loadRoute("src/app/api/stock-loads/route.ts", makeModuleMocks({ prisma }));
  const body = {
    productId: "prod1aaaaaaaaaaaaaaaaaaa",
    quantity: 2,
    unitPrice: 60,
    createPurchaseRequest: false,
  };

  const first = await route.POST(makeRequest(body, "stock-load-key-clean"));
  assert.equal(first.status, 201);
  const firstJson = await first.json();
  assert.equal(firstJson.stockLoad.product.id, "prod1aaaaaaaaaaaaaaaaaaa");
  assert.equal(firstJson.stockLoad.product.stock, 12);
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").quantity, 12);
  assert.equal(prisma.state.stockMovements.length, 1);
  assert.equal(prisma.state.cashMovements.length, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);

  const second = await route.POST(makeRequest(body, "stock-load-key-clean"));
  assert.equal(second.status, 201);
  const secondJson = await second.json();

  assert.deepEqual(secondJson, firstJson);
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").quantity, 12);
  assert.equal(prisma.state.stockMovements.length, 1);
  assert.equal(prisma.state.cashMovements.length, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("stock-loads auto-created products keep cost but leave sale price pending", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  const route = loadRoute("src/app/api/stock-loads/route.ts", makeModuleMocks({ prisma }));
  const body = {
    itemName: "Arena fina",
    quantity: 4,
    unitPrice: 2500,
    createPurchaseRequest: false,
  };

  const response = await route.POST(makeRequest(body, "stock-load-new-product-price-clean"));
  assert.equal(response.status, 201);

  const createdProduct = [...prisma.state.products.values()].find((product) => product.name === "Arena fina");
  assert.ok(createdProduct);
  assert.equal(createdProduct.price, 0);
  assert.equal(createdProduct.costPrice, 2500);
  assert.equal(prisma.state.products.get(createdProduct.id).quantity, 4);
});

test("undo replays a duplicate submit without deleting twice", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa", name: "Acme", salesCount: 0 })],
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const body = {
    target: "customer",
    count: 1,
  };

  const first = await route.POST(makeRequest(body, "undo-key-clean"));
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(firstJson.deleted, 1);
  assert.equal(prisma.calls.customerDeleteMany, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);

  const second = await route.POST(makeRequest(body, "undo-key-clean"));
  assert.equal(second.status, 200);
  const secondJson = await second.json();

  assert.deepEqual(secondJson, firstJson);
  assert.equal(prisma.calls.customerDeleteMany, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("undo stock path records an audit event and replays safely", async () => {
  // inventory model merged into Product.quantity (commit 42085b00); seed quantity on product directly.
  const product = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", quantity: 8 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [product],
    inventory: [],
    stockMovements: [
      makeStockMovement({
        id: "stock-load-1",
        productId: "prod1aaaaaaaaaaaaaaaaaaa",
        productName: "Widget",
        delta: 2,
        quantityBefore: 6,
        quantityAfter: 8,
        reason: "stock_load",
        referenceId: "movement1aaaaaaaaaaaaaaa",
        createdAt: new Date(),
      }),
    ],
    cashMovements: [
      {
        id: "movement1aaaaaaaaaaaaaaa",
        businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
        saleId: null,
        type: "purchase",
        description: "Ingreso de stock: 2 Widget",
        amount: 200,
        date: "2024-01-01T00:00:00.000Z",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ],
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const body = {
    target: "stock",
    count: 1,
  };

  const first = await route.POST(makeRequest(body, "undo-stock-key"));
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(firstJson.deleted, 1);
  // After undo: product.quantity was 8, decrement by delta=2 → 6
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").quantity, 6);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);

  const second = await route.POST(makeRequest(body, "undo-stock-key"));
  assert.equal(second.status, 200);
  const secondJson = await second.json();

  assert.deepEqual(secondJson, firstJson);
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").quantity, 6);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("undo sale: 3 sales in last 24h are deleted, stock restored, cash refunded, 3 audits emitted", async () => {
  // inventory model merged into Product.quantity (commit 42085b00); seed quantity on products directly.
  const product1 = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget A", quantity: 5 });
  const product2 = makeProduct({ id: "prod2aaaaaaaaaaaaaaaaaaa", name: "Widget B", quantity: 5 });
  const product3 = makeProduct({ id: "prod3aaaaaaaaaaaaaaaaaaa", name: "Widget C", quantity: 5 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa", name: "Acme", salesCount: 3 })],
    products: [product1, product2, product3],
    inventory: [],
  });

  const now = Date.now();
  prisma.state.sales.push(
    makeSale({ id: "sale1aaaaaaaaaaaaaaaaaaa", date: new Date(now - 60 * 1000), totalAmount: 200 }),
    makeSale({ id: "sale2aaaaaaaaaaaaaaaaaaa", date: new Date(now - 2 * 60 * 1000), totalAmount: 200 }),
    makeSale({ id: "sale3aaaaaaaaaaaaaaaaaaa", date: new Date(now - 3 * 60 * 1000), totalAmount: 200 }),
  );
  prisma.state.saleItems.push(
    { saleId: "sale1aaaaaaaaaaaaaaaaaaa", productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 2, unitPrice: 100 },
    { saleId: "sale2aaaaaaaaaaaaaaaaaaa", productId: "prod2aaaaaaaaaaaaaaaaaaa", quantity: 2, unitPrice: 100 },
    { saleId: "sale3aaaaaaaaaaaaaaaaaaa", productId: "prod3aaaaaaaaaaaaaaaaaaa", quantity: 2, unitPrice: 100 },
  );
  prisma.state.cashMovements.push(
    { id: "cm1aaaaaaaaaaaaaaaaaaaaa", businessId: "biz1aaaaaaaaaaaaaaaaaaaa", saleId: "sale1aaaaaaaaaaaaaaaaaaa", type: "income", description: "Venta", amount: 200, date: "2024-01-01T00:00:00Z", createdAt: "2024-01-01T00:00:00Z" },
    { id: "cm2aaaaaaaaaaaaaaaaaaaaa", businessId: "biz1aaaaaaaaaaaaaaaaaaaa", saleId: "sale2aaaaaaaaaaaaaaaaaaa", type: "income", description: "Venta", amount: 200, date: "2024-01-01T00:00:00Z", createdAt: "2024-01-01T00:00:00Z" },
    { id: "cm3aaaaaaaaaaaaaaaaaaaaa", businessId: "biz1aaaaaaaaaaaaaaaaaaaa", saleId: "sale3aaaaaaaaaaaaaaaaaaa", type: "income", description: "Venta", amount: 200, date: "2024-01-01T00:00:00Z", createdAt: "2024-01-01T00:00:00Z" },
  );

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(makeRequest({ target: "sale", count: 3 }, "undo-sale-happy-path"));

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.deleted, 3);
  assert.equal(Array.isArray(json.summary), true);
  assert.equal(json.summary.length, 3);

  // All sales gone
  assert.equal(prisma.state.sales.length, 0);
  assert.equal(prisma.state.saleItems.length, 0);
  // Stock restored: product.quantity was 5, each sale had quantity=2, so +2 each → 7
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").quantity, 7);
  assert.equal(prisma.state.products.get("prod2aaaaaaaaaaaaaaaaaaa").quantity, 7);
  assert.equal(prisma.state.products.get("prod3aaaaaaaaaaaaaaaaaaa").quantity, 7);
  // Cash refunded — all sale-linked movements deleted
  assert.equal(prisma.state.cashMovements.length, 0);
  // One audit per sale
  assert.equal(prisma.state.criticalWriteEvents.length, 3);
  for (const event of prisma.state.criticalWriteEvents) {
    assert.equal(event.actionType, "undo.sale");
    assert.equal(event.resourceType, "sale");
  }
});

test("undo sale: rejects with 400 when a sale has a sent or paid invoice (TOCTOU lock)", async () => {
  // inventory model merged into Product.quantity; seed quantity on product directly.
  const product = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", quantity: 5 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa", name: "Acme", salesCount: 1 })],
    products: [product],
    inventory: [],
  });

  const now = Date.now();
  prisma.state.sales.push(
    makeSale({ id: "sale1aaaaaaaaaaaaaaaaaaa", date: new Date(now - 60 * 1000), totalAmount: 200 })
  );
  prisma.state.saleItems.push({ saleId: "sale1aaaaaaaaaaaaaaaaaaa", productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 2, unitPrice: 100 });
  prisma.state.invoices.push(
    makeInvoice({
      id: "inv1aaaaaaaaaaaaaaaaaaaa",
      saleId: "sale1aaaaaaaaaaaaaaaaaaa",
      invoiceNumber: "FC-0001-00000042",
      status: "sent",
      documentType: "invoice",
      sequenceNumber: 42,
    })
  );

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(makeRequest({ target: "sale", count: 1 }, "undo-sale-invoice-locked"));

  assert.equal(response.status, 400);
  const json = await response.json();
  assert.match(json.error, /No se puede deshacer.*FC-0001-00000042.*enviada/);

  // Nothing mutated — the TOCTOU check threw inside the tx and unwound
  assert.equal(prisma.state.sales.length, 1);
  assert.equal(prisma.state.saleItems.length, 1);
  assert.equal(prisma.state.invoices.length, 1);
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").quantity, 5);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("undo sale: returns 404 when no sales exist within the 24h window", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa", name: "Acme", salesCount: 0 })],
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(makeRequest({ target: "sale", count: 1 }, "undo-sale-empty"));

  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, /No hay ventas recientes para deshacer/);

  assert.equal(prisma.state.sales.length, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("undo sale: cutoff includes 23h-old sales, excludes 24h+1min-old sales", async () => {
  // inventory model merged into Product.quantity; seed quantity on product directly.
  const product = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", quantity: 5 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa", name: "Acme", salesCount: 2 })],
    products: [product],
    inventory: [],
  });

  const now = Date.now();
  prisma.state.sales.push(
    makeSale({
      id: "saleoldaaaaaaaaaaaaaaaaa",
      date: new Date(now - 24 * 60 * 60 * 1000 - 60 * 1000), // 24h+1min ago — outside
      totalAmount: 100,
    }),
    makeSale({
      id: "salerecentaaaaaaaaaaaaaa",
      date: new Date(now - 23 * 60 * 60 * 1000), // 23h ago — inside
      totalAmount: 200,
    })
  );
  prisma.state.saleItems.push(
    { saleId: "saleoldaaaaaaaaaaaaaaaaa", productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 1, unitPrice: 100 },
    { saleId: "salerecentaaaaaaaaaaaaaa", productId: "prod1aaaaaaaaaaaaaaaaaaa", quantity: 2, unitPrice: 100 },
  );

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(makeRequest({ target: "sale", count: 5 }, "undo-sale-cutoff"));

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.deleted, 1);

  // Only the recent sale was deleted; the 24h+1min sale stays
  assert.equal(prisma.state.sales.length, 1);
  assert.equal(prisma.state.sales[0].id, "saleoldaaaaaaaaaaaaaaaaa");
  assert.equal(prisma.state.saleItems.length, 1);
  assert.equal(prisma.state.saleItems[0].saleId, "saleoldaaaaaaaaaaaaaaaaa");
  // Stock restored only by the recent sale's quantity (2): was 5 + 2 = 7
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").quantity, 7);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("undo sale: count=5 deletes the 5 most recent sales, oldest remains untouched", async () => {
  // inventory model merged into Product.quantity; seed quantity on product directly.
  const product = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", quantity: 0 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [makeCustomer({ id: "cust1aaaaaaaaaaaaaaaaaaa", name: "Acme", salesCount: 6 })],
    products: [product],
    inventory: [],
  });

  const now = Date.now();
  // sale-1 newest (1 min ago), sale-6 oldest (6 min ago) — all inside 24h window.
  for (let i = 1; i <= 6; i += 1) {
    prisma.state.sales.push(
      makeSale({
        id: padId("sale", i),
        date: new Date(now - i * 60 * 1000),
        totalAmount: 100,
      })
    );
    prisma.state.saleItems.push({
      saleId: padId("sale", i),
      productId: "prod1aaaaaaaaaaaaaaaaaaa",
      quantity: 1,
      unitPrice: 100,
    });
  }

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(makeRequest({ target: "sale", count: 5 }, "undo-sale-batch"));

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.deleted, 5);
  assert.equal(json.summary.length, 5);

  // 5 most recent (sale-1..sale-5) deleted, sale-6 (oldest) stays
  assert.equal(prisma.state.sales.length, 1);
  assert.equal(prisma.state.sales[0].id, "sale6aaaaaaaaaaaaaaaaaaa");
  // Each deleted sale had quantity=1, so stock restored by 5: was 0 + 5 = 5
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").quantity, 5);
  assert.equal(prisma.state.criticalWriteEvents.length, 5);
});

test("undo product: restores a recently deleted product with its original id, fields, and stock", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  // Seed the product.delete audit trace, deletion 1 minute ago (well within 24h)
  prisma.state.criticalWriteEvents.push({
    id: "cwe-delete-1",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
    routeScope: "products",
    actionType: "product.delete",
    resourceType: "product",
    resourceId: "proddeletedaaaaaaaaaaaaa",
    summary: "Producto eliminado",
    payloadJson: JSON.stringify({
      name: "Widget Deluxe",
      price: 250,
      stock: 8,
      sku: "WGT-D",
      costPrice: 150,
    }),
    createdAt: new Date(Date.now() - 60 * 1000),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "product", productId: "proddeletedaaaaaaaaaaaaa" }, "undo-product-happy")
  );

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.restored, 1);
  assert.equal(json.productId, "proddeletedaaaaaaaaaaaaa");
  assert.equal(json.name, "Widget Deluxe");

  // Product re-created with the original id and all fields from the audit payload
  assert.equal(prisma.state.products.has("proddeletedaaaaaaaaaaaaa"), true);
  const restored = prisma.state.products.get("proddeletedaaaaaaaaaaaaa");
  assert.equal(restored.name, "Widget Deluxe");
  assert.equal(restored.price, 250);
  assert.equal(restored.sku, "WGT-D");
  assert.equal(restored.costPrice, 150);
  assert.equal(restored.businessId, "biz1aaaaaaaaaaaaaaaaaaaa");

  // Stock restored from the audit payload (stock: 8 → product.quantity = 8)
  assert.equal(prisma.state.products.get("proddeletedaaaaaaaaaaaaa").quantity, 8);

  // Two audit events total: original product.delete (seeded) + new undo.product
  assert.equal(prisma.state.criticalWriteEvents.length, 2);
  const undoEvent = prisma.state.criticalWriteEvents.find((e) => e.actionType === "undo.product");
  assert.ok(undoEvent);
  assert.equal(undoEvent.resourceId, "proddeletedaaaaaaaaaaaaa");
  assert.equal(undoEvent.resourceType, "product");
});

test("undo product: returns 404 when no product.delete audit exists for the given productId", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  // No criticalWriteEvent seeded — handler should fail to locate the trace
  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "product", productId: "prodghostaaaaaaaaaaaaaaa" }, "undo-product-not-found")
  );

  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, /No se encontró información del producto eliminado/);

  // No mutation: no product re-created, no audit emitted
  assert.equal(prisma.state.products.size, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("undo product: restores only the targeted product and leaves other audit traces untouched", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  const deletedAt = new Date(Date.now() - 60 * 1000);

  // Two distinct deleted products, each with its own audit trace
  prisma.state.criticalWriteEvents.push(
    {
      id: "cwe-A",
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
      routeScope: "products",
      actionType: "product.delete",
      resourceType: "product",
      resourceId: "prod-A",
      summary: "Producto A eliminado",
      payloadJson: JSON.stringify({ name: "Widget A", price: 100, stock: 3 }),
      createdAt: deletedAt,
    },
    {
      id: "cwe-B",
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
      routeScope: "products",
      actionType: "product.delete",
      resourceType: "product",
      resourceId: "prod-B",
      summary: "Producto B eliminado",
      payloadJson: JSON.stringify({ name: "Widget B", price: 200, stock: 5 }),
      createdAt: deletedAt,
    }
  );

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "product", productId: "prod-A" }, "undo-product-boundary")
  );

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.productId, "prod-A");
  assert.equal(json.name, "Widget A");

  // Only prod-A was restored; prod-B stays absent
  assert.equal(prisma.state.products.has("prod-A"), true);
  assert.equal(prisma.state.products.has("prod-B"), false);
  assert.equal(prisma.state.products.get("prod-A").price, 100);
  // Stock restored from audit payload (stock: 3 → product.quantity = 3)
  assert.equal(prisma.state.products.get("prod-A").quantity, 3);

  // Both delete audits remain (they're history, not consumed by the undo)
  const deleteAudits = prisma.state.criticalWriteEvents.filter((e) => e.actionType === "product.delete");
  assert.equal(deleteAudits.length, 2);
  assert.ok(deleteAudits.find((e) => e.resourceId === "prod-A"));
  assert.ok(deleteAudits.find((e) => e.resourceId === "prod-B"));

  // Exactly one undo audit, pointing to prod-A
  const undoAudits = prisma.state.criticalWriteEvents.filter((e) => e.actionType === "undo.product");
  assert.equal(undoAudits.length, 1);
  assert.equal(undoAudits[0].resourceId, "prod-A");
});

test("undo product: returns 400 when the product.delete audit is older than 24 hours", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  // Audit from 25 hours ago — outside the 24h cutoff window
  prisma.state.criticalWriteEvents.push({
    id: "cwe-stale",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
    routeScope: "products",
    actionType: "product.delete",
    resourceType: "product",
    resourceId: "prodstaleaaaaaaaaaaaaaaa",
    summary: "Producto eliminado",
    payloadJson: JSON.stringify({ name: "Old Widget", price: 100, stock: 5 }),
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "product", productId: "prodstaleaaaaaaaaaaaaaaa" }, "undo-product-cutoff")
  );

  assert.equal(response.status, 400);
  const json = await response.json();
  assert.match(json.error, /No se puede restaurar.*más de 24 horas/);

  // No restoration occurred
  assert.equal(prisma.state.products.has("prodstaleaaaaaaaaaaaaaaa"), false);
  // Original audit untouched, no undo audit emitted
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  assert.equal(prisma.state.criticalWriteEvents[0].actionType, "product.delete");
});

test("undo product: returns 500 when audit payloadJson is missing required fields (no partial restore)", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  // Audit exists within the window, but payloadJson lacks the required `name` field —
  // parseRestoredProductData rejects this and the handler must abort cleanly.
  prisma.state.criticalWriteEvents.push({
    id: "cwe-bad",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
    routeScope: "products",
    actionType: "product.delete",
    resourceType: "product",
    resourceId: "prodbadaaaaaaaaaaaaaaaaa",
    summary: "Producto eliminado",
    payloadJson: JSON.stringify({ price: 100, stock: 5 }),
    createdAt: new Date(Date.now() - 60 * 1000),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "product", productId: "prodbadaaaaaaaaaaaaaaaaa" }, "undo-product-corrupt")
  );

  assert.equal(response.status, 500);
  const json = await response.json();
  assert.match(json.error, /No se pudo leer la información del producto eliminado/);

  // No partial restoration: product was not re-created
  assert.equal(prisma.state.products.has("prodbadaaaaaaaaaaaaaaaaa"), false);
  // Only the seeded delete audit remains; no undo audit emitted
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  assert.equal(prisma.state.criticalWriteEvents[0].actionType, "product.delete");
});

test("undo product: returns 400 when productId is missing from the request body", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "product" }, "undo-product-missing-id")
  );

  assert.equal(response.status, 400);
  const json = await response.json();
  assert.match(json.error, /Falta el identificador del producto/);

  // No mutation, no audit
  assert.equal(prisma.state.products.size, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("undo supplier: deletes a recently created supplier when its supplier.create audit is within the cutoff window", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    suppliers: [makeSupplier({ id: "supnewaaaaaaaaaaaaaaaaaa", name: "Paper Co", phone: "1144556677" })],
  });

  // Audit trace from 1 minute ago — well within 24h
  prisma.state.criticalWriteEvents.push({
    id: "cwe-create-sup",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
    routeScope: "suppliers",
    actionType: "supplier.create",
    resourceType: "supplier",
    resourceId: "supnewaaaaaaaaaaaaaaaaaa",
    summary: "Proveedor creado",
    payloadJson: JSON.stringify({ name: "Paper Co" }),
    createdAt: new Date(Date.now() - 60 * 1000),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "supplier", count: 1 }, "undo-supplier-happy")
  );

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.deleted, 1);
  assert.deepEqual(json.summary, ["Paper Co"]);

  // Supplier removed from state
  assert.equal(prisma.state.suppliers.has("supnewaaaaaaaaaaaaaaaaaa"), false);

  // Two audits total: original supplier.create + new undo.supplier
  assert.equal(prisma.state.criticalWriteEvents.length, 2);
  const undoEvent = prisma.state.criticalWriteEvents.find((e) => e.actionType === "undo.supplier");
  assert.ok(undoEvent);
  assert.equal(undoEvent.resourceType, "supplier");
});

test("undo supplier: returns 404 when no supplier.create audit exists", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    suppliers: [],
  });
  // No audit seeded — handler must abort with not-found

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "supplier", count: 1 }, "undo-supplier-not-found")
  );

  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, /No hay proveedores recientes para deshacer/);

  assert.equal(prisma.state.suppliers.size, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("undo supplier: returns 404 when the only supplier.create audit is older than 24 hours", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    suppliers: [makeSupplier({ id: "supstaleaaaaaaaaaaaaaaaa", name: "Old Paper Co" })],
  });

  // Audit from 25 hours ago — outside the 24h cutoff
  prisma.state.criticalWriteEvents.push({
    id: "cwe-stale-sup",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
    routeScope: "suppliers",
    actionType: "supplier.create",
    resourceType: "supplier",
    resourceId: "supstaleaaaaaaaaaaaaaaaa",
    summary: "Proveedor creado",
    payloadJson: JSON.stringify({ name: "Old Paper Co" }),
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "supplier", count: 1 }, "undo-supplier-cutoff")
  );

  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, /No hay proveedores recientes para deshacer/);

  // Supplier still in state, original audit untouched, no undo audit
  assert.equal(prisma.state.suppliers.has("supstaleaaaaaaaaaaaaaaaa"), true);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("undo supplier: returns 404 when supplier.create audit exists but the supplier was already removed (audit/state mismatch)", async () => {
  // The supplier handler does not parse payloadJson — it uses resourceId only.
  // The closest analog to "corrupt payload" is when the audit references a
  // supplier that no longer exists in the DB. Handler must abort cleanly
  // rather than try to delete a phantom row.
  const prisma = createFakePrisma({
    business: makeBusiness(),
    suppliers: [],
  });

  prisma.state.criticalWriteEvents.push({
    id: "cwe-phantom-sup",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
    routeScope: "suppliers",
    actionType: "supplier.create",
    resourceType: "supplier",
    resourceId: "supphantomaaaaaaaaaaaaaa",
    summary: "Proveedor creado",
    payloadJson: JSON.stringify({ name: "Phantom Co" }),
    createdAt: new Date(Date.now() - 60 * 1000),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "supplier", count: 1 }, "undo-supplier-phantom")
  );

  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, /El proveedor ya fue eliminado/);

  // No mutation; original audit retained, no undo audit emitted
  assert.equal(prisma.state.suppliers.size, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  assert.equal(prisma.state.criticalWriteEvents[0].actionType, "supplier.create");
});

test("undo cash-movement: deletes a recent manual cash movement (saleId null) within the cutoff window", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
  });

  // Manual cash movement (saleId: null) created 1 minute ago — within window
  prisma.state.cashMovements.push({
    id: "cm-manual-1",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    saleId: null,
    type: "purchase",
    description: "Pagué la luz",
    amount: 3000,
    date: new Date(Date.now() - 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "cash-movement", count: 1 }, "undo-cm-happy")
  );

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.deleted, 1);
  assert.deepEqual(json.summary, ["Pagué la luz"]);

  // Movement removed
  assert.equal(prisma.state.cashMovements.length, 0);
  // Audit emitted (no prior audits in this test)
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  assert.equal(prisma.state.criticalWriteEvents[0].actionType, "undo.cash-movement");
});

test("undo cash-movement: returns 404 when no manual cash movements exist in the window", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
  });
  // No movements seeded

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "cash-movement", count: 1 }, "undo-cm-not-found")
  );

  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, /No hay movimientos de caja para deshacer/);

  assert.equal(prisma.state.cashMovements.length, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("undo cash-movement: returns 404 when the only manual movement is older than 24 hours", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
  });

  // Manual movement from 25 hours ago — outside cutoff
  prisma.state.cashMovements.push({
    id: "cmstaleaaaaaaaaaaaaaaaaa",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    saleId: null,
    type: "purchase",
    description: "Pagué algo viejo",
    amount: 1000,
    date: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "cash-movement", count: 1 }, "undo-cm-cutoff")
  );

  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, /No hay movimientos de caja para deshacer/);

  // Movement still in state, no audit
  assert.equal(prisma.state.cashMovements.length, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("undo cash-movement: ignores sale-linked movements (saleId set), only deletes manual ones", async () => {
  // The handler does not parse payloadJson — it filters by saleId: null in
  // the query. Closest analog to "corrupt payload": verify that a sale-linked
  // movement is NOT picked up (otherwise the cash ledger would diverge from
  // the sale record).
  const prisma = createFakePrisma({
    business: makeBusiness(),
  });

  // Only a sale-linked movement exists, no manual ones
  prisma.state.cashMovements.push({
    id: "cm-sale-linked",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    saleId: "sale1aaaaaaaaaaaaaaaaaaa",
    type: "income",
    description: "Venta a Acme",
    amount: 200,
    date: new Date(Date.now() - 60 * 1000).toISOString(),
    createdAt: new Date(Date.now() - 60 * 1000).toISOString(),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "cash-movement", count: 1 }, "undo-cm-sale-linked")
  );

  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, /No hay movimientos de caja para deshacer/);

  // Sale-linked movement untouched
  assert.equal(prisma.state.cashMovements.length, 1);
  assert.equal(prisma.state.cashMovements[0].id, "cm-sale-linked");
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("undo product-create: deletes a recently created product (no saleItems) and its inventory + stockMovements", async () => {
  // inventory model merged into Product.quantity; seed quantity on product directly.
  const product = makeProduct({ id: "prodnewaaaaaaaaaaaaaaaaa", name: "Recently Created", quantity: 7 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [product],
    inventory: [],
    stockMovements: [
      makeStockMovement({
        id: "sm-init",
        productId: "prodnewaaaaaaaaaaaaaaaaa",
        productName: "Recently Created",
        reason: "stock_load",
      }),
    ],
  });

  // product.create audit from 1 minute ago — within cutoff
  prisma.state.criticalWriteEvents.push({
    id: "cwe-pcreate",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
    routeScope: "products",
    actionType: "product.create",
    resourceType: "product",
    resourceId: "prodnewaaaaaaaaaaaaaaaaa",
    summary: "Producto creado",
    payloadJson: JSON.stringify({ name: "Recently Created" }),
    createdAt: new Date(Date.now() - 60 * 1000),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "product-create" }, "undo-pcreate-happy")
  );

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.deleted, 1);
  assert.deepEqual(json.summary, ["Recently Created"]);

  // Product and stockMovements all gone (inventory model merged into product.quantity)
  assert.equal(prisma.state.products.has("prodnewaaaaaaaaaaaaaaaaa"), false);
  assert.equal(prisma.state.stockMovements.length, 0);

  // Two audits: original product.create + new undo.product-create
  assert.equal(prisma.state.criticalWriteEvents.length, 2);
  const undoEvent = prisma.state.criticalWriteEvents.find((e) => e.actionType === "undo.product-create");
  assert.ok(undoEvent);
  assert.equal(undoEvent.resourceId, "prodnewaaaaaaaaaaaaaaaaa");
});

test("undo product-create: returns 404 when no product.create audit exists", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "product-create" }, "undo-pcreate-not-found")
  );

  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, /No hay productos recientes para deshacer/);

  assert.equal(prisma.state.products.size, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("undo product-create: returns 404 when the only product.create audit is older than 24 hours", async () => {
  // inventory model merged into Product.quantity; seed quantity on product directly.
  const product = makeProduct({ id: "prod-stale-create", name: "Old Created", quantity: 5 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [product],
    inventory: [],
  });

  prisma.state.criticalWriteEvents.push({
    id: "cwe-stale-pcreate",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
    routeScope: "products",
    actionType: "product.create",
    resourceType: "product",
    resourceId: "prod-stale-create",
    summary: "Producto creado",
    payloadJson: JSON.stringify({ name: "Old Created" }),
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "product-create" }, "undo-pcreate-cutoff")
  );

  assert.equal(response.status, 404);
  const json = await response.json();
  assert.match(json.error, /No hay productos recientes para deshacer/);

  // Product still in state, original audit untouched, no undo audit
  assert.equal(prisma.state.products.has("prod-stale-create"), true);
  assert.equal(prisma.state.products.get("prod-stale-create").quantity, 5);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("undo product-create: returns 409 when the product already has sale items (FK preservation)", async () => {
  // The handler does not parse payloadJson — it uses resourceId then verifies
  // _count.saleItems via the product.findFirst select. Closest analog to
  // "corrupt payload": the product is referentially integral to existing sales,
  // so the undo must refuse rather than orphan SaleItem rows.
  // inventory model merged into Product.quantity; seed quantity on product directly.
  const product = makeProduct({ id: "prod-with-sales", name: "Sold Item", quantity: 3 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [product],
    inventory: [],
  });

  // SaleItem referencing this product — handler must refuse the undo
  prisma.state.saleItems.push({
    saleId: "some-sale",
    productId: "prod-with-sales",
    quantity: 1,
    unitPrice: 100,
  });

  prisma.state.criticalWriteEvents.push({
    id: "cwe-pcreate-with-sales",
    businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
    actorUserId: "user1aaaaaaaaaaaaaaaaaaa",
    routeScope: "products",
    actionType: "product.create",
    resourceType: "product",
    resourceId: "prod-with-sales",
    summary: "Producto creado",
    payloadJson: JSON.stringify({ name: "Sold Item" }),
    createdAt: new Date(Date.now() - 60 * 1000),
  });

  const route = loadRoute("src/app/api/undo/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(
    makeRequest({ target: "product-create" }, "undo-pcreate-has-sales")
  );

  assert.equal(response.status, 409);
  const json = await response.json();
  assert.match(json.error, /No se puede deshacer.*Sold Item.*ya tiene ventas registradas/);

  // Nothing deleted: product, saleItem, original audit all intact
  assert.equal(prisma.state.products.has("prod-with-sales"), true);
  assert.equal(prisma.state.saleItems.length, 1);
  // No undo audit emitted; only the seeded product.create remains
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  assert.equal(prisma.state.criticalWriteEvents[0].actionType, "product.create");
});

test("customers POST: writes a customer.create audit and is replay-safe under the same idempotency key", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [],
  });

  const route = loadRoute("src/app/api/customers/route.ts", makeModuleMocks({ prisma }));
  const body = { name: "Acme", phone: "1144556677", email: "ventas@acme.com", taxId: null };

  const first = await route.POST(makeRequest(body, "customer-create-key"));
  assert.equal(first.status, 201);
  const firstJson = await first.json();
  assert.ok(firstJson.customer);
  assert.equal(firstJson.customer.name, "Acme");
  assert.equal(firstJson.customer.phone, "1144556677");
  assert.equal(firstJson.customer.email, "ventas@acme.com");

  // Audit trace fires at runtime — the contract declares it, this verifies it
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  const audit = prisma.state.criticalWriteEvents[0];
  assert.equal(audit.actionType, "customer.create");
  assert.equal(audit.resourceType, "customer");
  assert.equal(audit.resourceId, firstJson.customer.id);
  assert.match(audit.summary, /Cliente creado.*Acme/);

  // Replay safety: same key → identical response, no duplicate customer, no duplicate audit
  const second = await route.POST(makeRequest(body, "customer-create-key"));
  assert.equal(second.status, 201);
  const secondJson = await second.json();
  assert.deepEqual(secondJson, firstJson);
  assert.equal(prisma.state.customers.size, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("customers PATCH: applies field updates, writes a customer.update audit, and stays replay-safe", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [{
      id: "cust1aaaaaaaaaaaaaaaaaaa",
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      name: "Acme",
      phone: "1100000000",
      email: null,
      taxId: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      salesCount: 0,
    }],
  });

  const route = loadRoute("src/app/api/customers/route.ts", makeModuleMocks({ prisma }));
  const body = { id: "cust1aaaaaaaaaaaaaaaaaaa", phone: "1199998888", email: "nuevo@acme.com" };

  const first = await route.PATCH(makeRequest(body, "customer-update-key"));
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(firstJson.ok, true);

  // Field updates landed in the persistent state
  const updated = prisma.state.customers.get("cust1aaaaaaaaaaaaaaaaaaa");
  assert.equal(updated.phone, "1199998888");
  assert.equal(updated.email, "nuevo@acme.com");
  assert.equal(updated.name, "Acme"); // name not in body — should not change

  // Audit trace fires
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  const audit = prisma.state.criticalWriteEvents[0];
  assert.equal(audit.actionType, "customer.update");
  assert.equal(audit.resourceId, "cust1aaaaaaaaaaaaaaaaaaa");

  // Replay safety
  const second = await route.PATCH(makeRequest(body, "customer-update-key"));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), firstJson);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("suppliers POST: writes a supplier.create audit and is replay-safe under the same idempotency key", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    suppliers: [],
  });

  const route = loadRoute("src/app/api/suppliers/route.ts", makeModuleMocks({ prisma }));
  const body = {
    name: "Aceros del Oeste",
    phone: "2615551234",
    email: "ventas@aceros.com",
    contactName: "Pedro",
  };

  const first = await route.POST(makeRequest(body, "supplier-create-key"));
  assert.equal(first.status, 201);
  const firstJson = await first.json();
  assert.ok(firstJson.supplier);
  // normalizeSupplierName title-cases each token: "Aceros del Oeste" → "Aceros Del Oeste"
  assert.equal(firstJson.supplier.name, "Aceros Del Oeste");
  assert.equal(firstJson.supplier.phone, "2615551234");
  assert.equal(firstJson.supplier.contactName, "Pedro");

  // Audit trace fires at runtime
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  const audit = prisma.state.criticalWriteEvents[0];
  assert.equal(audit.actionType, "supplier.create");
  assert.equal(audit.resourceType, "supplier");
  assert.equal(audit.resourceId, firstJson.supplier.id);
  assert.match(audit.summary, /Proveedor creado.*Aceros Del Oeste/);

  // Replay safety
  const second = await route.POST(makeRequest(body, "supplier-create-key"));
  assert.equal(second.status, 201);
  assert.deepEqual(await second.json(), firstJson);
  assert.equal(prisma.state.suppliers.size, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("suppliers PATCH: applies field updates, writes a supplier.update audit, and stays replay-safe", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    suppliers: [makeSupplier({ id: "sup1aaaaaaaaaaaaaaaaaaaa", name: "Aceros del Oeste", phone: "2611111111" })],
  });

  const route = loadRoute("src/app/api/suppliers/route.ts", makeModuleMocks({ prisma }));
  const body = { id: "sup1aaaaaaaaaaaaaaaaaaaa", phone: "2619998888", contactName: "Nuevo Encargado" };

  const first = await route.PATCH(makeRequest(body, "supplier-update-key"));
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(firstJson.ok, true);

  // Field updates landed in persistent state
  const updated = prisma.state.suppliers.get("sup1aaaaaaaaaaaaaaaaaaaa");
  assert.equal(updated.phone, "2619998888");
  assert.equal(updated.contactName, "Nuevo Encargado");
  assert.equal(updated.name, "Aceros del Oeste"); // name not in body — should not change

  // Audit trace fires
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  const audit = prisma.state.criticalWriteEvents[0];
  assert.equal(audit.actionType, "supplier.update");
  assert.equal(audit.resourceId, "sup1aaaaaaaaaaaaaaaaaaaa");

  // Replay safety
  const second = await route.PATCH(makeRequest(body, "supplier-update-key"));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), firstJson);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("customers POST: rejects duplicate name with 409 (uniqueness within business)", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [{
      id: "cust1aaaaaaaaaaaaaaaaaaa",
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      name: "Acme",
      phone: null,
      email: null,
      taxId: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      salesCount: 0,
    }],
  });

  const route = loadRoute("src/app/api/customers/route.ts", makeModuleMocks({ prisma }));
  // Same name (after normalization) as the seeded customer — uniqueness check must fire
  const response = await route.POST(makeRequest({ name: "Acme" }, "customer-dup-key"));

  assert.equal(response.status, 409);
  const json = await response.json();
  assert.match(json.message, /Ya existe un cliente con ese nombre/);

  // No new customer created, no audit emitted
  assert.equal(prisma.state.customers.size, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("customers PATCH: rejects renaming to an existing customer's name with 409", async () => {
  // Seed two customers; attempt to rename cust-1 → "Beta" (used by cust-2)
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [
      {
        id: "cust1aaaaaaaaaaaaaaaaaaa", businessId: "biz1aaaaaaaaaaaaaaaaaaaa", name: "Alpha",
        phone: null, email: null, taxId: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        salesCount: 0,
      },
      {
        id: "cust2aaaaaaaaaaaaaaaaaaa", businessId: "biz1aaaaaaaaaaaaaaaaaaaa", name: "Beta",
        phone: null, email: null, taxId: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        updatedAt: new Date("2024-01-01T00:00:00.000Z"),
        salesCount: 0,
      },
    ],
  });

  const route = loadRoute("src/app/api/customers/route.ts", makeModuleMocks({ prisma }));
  const response = await route.PATCH(makeRequest({ id: "cust1aaaaaaaaaaaaaaaaaaa", name: "Beta" }, "customer-rename-conflict"));

  assert.equal(response.status, 409);
  const json = await response.json();
  assert.match(json.message, /Ya existe un cliente con ese nombre/);

  // cust-1 still has its original name; cust-2 untouched; no audit
  assert.equal(prisma.state.customers.get("cust1aaaaaaaaaaaaaaaaaaa").name, "Alpha");
  assert.equal(prisma.state.customers.get("cust2aaaaaaaaaaaaaaaaaaa").name, "Beta");
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("customers PATCH: rejects body with no editable fields with 400", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    customers: [{
      id: "cust1aaaaaaaaaaaaaaaaaaa", businessId: "biz1aaaaaaaaaaaaaaaaaaaa", name: "Alpha",
      phone: null, email: null, taxId: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      updatedAt: new Date("2024-01-01T00:00:00.000Z"),
      salesCount: 0,
    }],
  });

  const route = loadRoute("src/app/api/customers/route.ts", makeModuleMocks({ prisma }));
  // Only id, no name/phone/email/taxId → must reject before touching the DB
  const response = await route.PATCH(makeRequest({ id: "cust1aaaaaaaaaaaaaaaaaaa" }, "customer-empty-patch"));

  assert.equal(response.status, 400);
  const json = await response.json();
  assert.match(json.message, /al menos un campo/i);

  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("suppliers POST: rejects duplicate name with 409 (uniqueness within business)", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    suppliers: [makeSupplier({ id: "supexistingaaaaaaaaaaaaa", name: "Aceros Del Oeste" })],
  });

  const route = loadRoute("src/app/api/suppliers/route.ts", makeModuleMocks({ prisma }));
  // Same name (post-normalization) as the existing supplier
  const response = await route.POST(makeRequest({ name: "Aceros del Oeste" }, "supplier-dup-key"));

  assert.equal(response.status, 409);
  const json = await response.json();
  assert.match(json.message, /Ya existe un proveedor con ese nombre/);

  // No new supplier created, no audit emitted
  assert.equal(prisma.state.suppliers.size, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("suppliers PATCH: rejects renaming to an existing supplier's name with 409", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    suppliers: [
      makeSupplier({ id: "sup1aaaaaaaaaaaaaaaaaaaa", name: "Alpha SA" }),
      makeSupplier({ id: "sup2aaaaaaaaaaaaaaaaaaaa", name: "Beta SA" }),
    ],
  });

  const route = loadRoute("src/app/api/suppliers/route.ts", makeModuleMocks({ prisma }));
  const response = await route.PATCH(makeRequest({ id: "sup1aaaaaaaaaaaaaaaaaaaa", name: "Beta SA" }, "supplier-rename-conflict"));

  assert.equal(response.status, 409);
  const json = await response.json();
  assert.match(json.message, /Ya existe un proveedor con ese nombre/);

  // sup-1 still has its original name; sup-2 untouched; no audit
  assert.equal(prisma.state.suppliers.get("sup1aaaaaaaaaaaaaaaaaaaa").name, "Alpha SA");
  assert.equal(prisma.state.suppliers.get("sup2aaaaaaaaaaaaaaaaaaaa").name, "Beta SA");
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("products POST: creates product + inventory + stock movement and emits a product.create audit (replay-safe)", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  const route = loadRoute("src/app/api/products/route.ts", makeModuleMocks({ prisma }));
  const body = { name: "Yerba Mate 1kg", price: 6200, stock: 10, costPrice: 4000 };

  const first = await route.POST(makeRequest(body, "product-create-key"));
  assert.equal(first.status, 201);
  const firstJson = await first.json();
  assert.ok(firstJson.product);
  assert.equal(firstJson.product.name, "Yerba Mate 1kg");
  assert.equal(firstJson.product.price, 6200);
  assert.equal(firstJson.product.costPrice, 4000);
  assert.equal(firstJson.product.stock, 10);

  // Product persisted with auto-generated SKU
  const created = [...prisma.state.products.values()].find((p) => p.name === "Yerba Mate 1kg");
  assert.ok(created);
  assert.ok(typeof created.sku === "string" && created.sku.length > 0);
  // Stock initialized on product.quantity (inventory model merged into Product — commit 42085b00)
  assert.equal(prisma.state.products.get(created.id).quantity, 10);
  // Stock movement recorded for the initial load (delta = initialStock)
  const movement = prisma.state.stockMovements.find((m) => m.productId === created.id);
  assert.ok(movement);
  assert.equal(movement.delta, 10);
  assert.equal(movement.quantityBefore, 0);
  assert.equal(movement.quantityAfter, 10);

  // Audit trace fires at runtime
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  const audit = prisma.state.criticalWriteEvents[0];
  assert.equal(audit.actionType, "product.create");
  assert.equal(audit.resourceId, created.id);
  assert.match(audit.summary, /Producto creado.*Yerba Mate/);

  // Replay safety
  const second = await route.POST(makeRequest(body, "product-create-key"));
  assert.equal(second.status, 201);
  assert.deepEqual(await second.json(), firstJson);
  assert.equal(prisma.state.products.size, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("products POST: rejects empty name with 400 (no audit, no product created)", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  const route = loadRoute("src/app/api/products/route.ts", makeModuleMocks({ prisma }));
  const response = await route.POST(makeRequest({ name: "", price: 100, stock: 5 }, "product-bad-name"));

  assert.equal(response.status, 400);
  const json = await response.json();
  assert.match(json.message, /nombre es obligatorio/i);

  assert.equal(prisma.state.products.size, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("products PATCH: updates price and emits a product.update audit (replay-safe)", async () => {
  // inventory model merged into Product.quantity; seed quantity on product directly.
  const product = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", price: 100, sku: "WIDGET-01", quantity: 5 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [product],
    inventory: [],
  });

  const route = loadRoute("src/app/api/products/route.ts", makeModuleMocks({ prisma }));
  const body = { id: "prod1aaaaaaaaaaaaaaaaaaa", price: 250 };

  const first = await route.PATCH(makeRequest(body, "product-update-key"));
  assert.equal(first.status, 200);
  const firstJson = await first.json();
  assert.equal(firstJson.ok, true);

  // Price actually changed in state; name + stock untouched
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").price, 250);
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").name, "Widget");
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").quantity, 5);

  // Audit fires with product.update actionType (NOT stock.adjust — body had a product field)
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  const audit = prisma.state.criticalWriteEvents[0];
  assert.equal(audit.actionType, "product.update");
  assert.equal(audit.resourceId, "prod1aaaaaaaaaaaaaaaaaaa");

  // Replay safety
  const second = await route.PATCH(makeRequest(body, "product-update-key"));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), firstJson);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("products PATCH: stock-only adjustment uses stock.adjust action type, not product.update", async () => {
  // Critical: when only stock is being changed, the contract requires the
  // audit to record actionType=stock.adjust so cash-balance and stock
  // reports can distinguish corrections from product edits.
  // inventory model merged into Product.quantity (commit 42085b00).
  // Seed quantity directly on the product record (not a separate inventory row).
  const product = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", price: 100, sku: "WIDGET-01", quantity: 3 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [product],
    inventory: [],
  });

  const route = loadRoute("src/app/api/products/route.ts", makeModuleMocks({ prisma }));
  // Only `stock` in body → isStockOnlyAdjustment=true → audit actionType="stock.adjust"
  const body = { id: "prod1aaaaaaaaaaaaaaaaaaa", stock: 12, stockReason: "manual" };

  const response = await route.PATCH(makeRequest(body, "product-stock-adjust-key"));
  assert.equal(response.status, 200);

  // After merge: stock lives in product.quantity, not a separate inventory table.
  assert.equal(prisma.state.products.get("prod1aaaaaaaaaaaaaaaaaaa").quantity, 12);
  const movement = prisma.state.stockMovements.find(
    (m) => m.productId === "prod1aaaaaaaaaaaaaaaaaaa" && m.delta === 9
  );
  assert.ok(movement, "expected a stock movement with delta=9 (12 - 3)");

  // Audit fires with stock.adjust (the contract distinction we're verifying)
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  const audit = prisma.state.criticalWriteEvents[0];
  assert.equal(audit.actionType, "stock.adjust");
  assert.equal(audit.resourceId, "prod1aaaaaaaaaaaaaaaaaaa");
});

test("onboarding GET returns 401 when the authenticated user has no owned business", async () => {
  // resolveActor returns null (not just actor with no businessId) when the
  // Business row is missing and the lazy-recovery via ensureBusinessPlaceholder
  // still can't find one. The route therefore returns 401 instead of the
  // onboarding payload — the caller should trigger re-onboarding flow via
  // the frontend.
  let businessLookupCalls = 0;
  const prisma = {
    business: {
      findUnique: async ({ where }) => {
        businessLookupCalls += 1;
        // Simulate user with no owned business (always null for any lookup)
        if (where?.userId === "user1aaaaaaaaaaaaaaaaaaa") return null;
        throw new Error("unexpected business lookup");
      },
    },
  };

  const route = loadRoute("src/app/api/onboarding/route.ts", makeModuleMocks({ prisma }));
  const response = await route.GET({
    nextUrl: new URL("http://localhost/api/onboarding?businessId=biz-foreign"),
  });

  // resolveActor cannot build an ActorContext without a Business row →
  // route returns 401 instead of the onboarding payload.
  assert.equal(response.status, 401);
  // resolveActor retries once via ensureBusinessPlaceholder (2 lookups total)
  assert.ok(businessLookupCalls >= 1, "expected at least one business lookup");
});

test("business patch accepts partial CUIT updates without requiring name or type in the payload", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness({
      type: "retail",
      taxRate: 21,
      phone: "1144445555",
      whatsappPhone: "5491144445555",
      address: "Calle 123",
    }),
  });

  const route = loadRoute("src/app/api/business/route.ts", makeModuleMocks({ prisma }));
  const response = await route.PATCH(makeRequest({ cuit: "20-12345678-9" }, "business-patch-key"));

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.business.cuit, "20-12345678-9");
  assert.equal(json.business.name, "Velora");
  assert.equal(json.business.type, "retail");
  assert.equal(prisma.state.business.cuit, "20-12345678-9");
});

test("mobile viewport keeps zoom enabled for Android accessibility", async () => {
  const layoutSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/layout.tsx"),
    "utf8"
  );

  assert.match(layoutSource, /initialScale:\s*1/);
  assert.doesNotMatch(layoutSource, /maximumScale\s*:/);
  assert.doesNotMatch(layoutSource, /userScalable\s*:/);
});

test("mobile WhatsApp and PDF flows avoid window.open and keep direct handoff fallbacks", async () => {
  const files = [
    "src/app/dashboard/lib/hooks.ts",
    "src/app/dashboard/components/InvoiceDetail.tsx",
    "src/app/dashboard/components/LowStockRow.tsx",
  ];

  for (const relativePath of files) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    assert.doesNotMatch(source, /window\.open/);
    assert.match(source, /navigateFromUserAction/);
  }

  // useBudget.ts uses executeDashboardAction (server-side), not window.open
  const budgetSource = fs.readFileSync(path.join(process.cwd(), "src/app/dashboard/lib/hooks/useBudget.ts"), "utf8");
  assert.doesNotMatch(budgetSource, /window\.open/);

  const hooksSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/dashboard/lib/hooks.ts"),
    "utf8"
  );
  const invoiceDetailSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/dashboard/components/InvoiceDetail.tsx"),
    "utf8"
  );
  const lowStockRowSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/dashboard/components/LowStockRow.tsx"),
    "utf8"
  );
  const budgetHookSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/dashboard/lib/hooks/useBudget.ts"),
    "utf8"
  );

  assert.match(hooksSource, /Abriendo WhatsApp\.\.\./);
  assert.match(hooksSource, /Abriendo PDF\.\.\./);
  assert.match(invoiceDetailSource, /No se pudo enviar la factura por WhatsApp/);
  assert.match(lowStockRowSource, /Abriendo WhatsApp\.\.\./);
  assert.match(budgetHookSource, /WhatsApp/);
});

test("products delete soft-archives the product when it has linked sales and records the archival", async () => {
  // inventory model merged into Product.quantity; seed quantity on product directly.
  const product = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", quantity: 10 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [product],
    inventory: [],
  });
  prisma.state.saleItems.push({
    saleId: "sale1aaaaaaaaaaaaaaaaaaa",
    productId: "prod1aaaaaaaaaaaaaaaaaaa",
    quantity: 1,
    unitPrice: 100,
  });

  const route = loadRoute("src/app/api/products/route.ts", makeModuleMocks({ prisma }));
  const response = await route.DELETE(makeRequest({ id: "prod1aaaaaaaaaaaaaaaaaaa" }, "product-delete-key"));

  // Hard-delete would break the SaleItem FK, so the route soft-archives:
  // product row stays (SKU prefixed with ARCHIVED_PRODUCT_SKU_PREFIX, filtered
  // out of active queries), inventory zeroed, sale history referentially
  // intact. Returns 200 with { ok: true, archived: true }.
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(json.archived, true);
  // Soft-archive: product row stays in the products map (filtered at query level by SKU prefix)
  assert.equal(prisma.state.products.has("prod1aaaaaaaaaaaaaaaaaaa"), true);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  const auditEvent = prisma.state.criticalWriteEvents[0];
  assert.equal(auditEvent.actionType, "product.delete");
  const auditPayload = JSON.parse(auditEvent.payloadJson);
  assert.equal(auditPayload.deleteMode, "soft_archived");
});

test("products delete succeeds even when the product has stock movements", async () => {
  const product = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", quantity: 10 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [product],
    inventory: [],
    stockMovements: [
      makeStockMovement({
        id: "stock-load-1",
        productId: "prod1aaaaaaaaaaaaaaaaaaa",
        productName: "Widget",
      }),
    ],
  });

  const route = loadRoute("src/app/api/products/route.ts", makeModuleMocks({ prisma }));
  const response = await route.DELETE(makeRequest({ id: "prod1aaaaaaaaaaaaaaaaaaa" }, "product-delete-key"));

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(prisma.state.products.has("prod1aaaaaaaaaaaaaaaaaaa"), false);
  // inventory model was merged into Product.quantity (commit 42085b00);
  // the delete path now removes the product row, not a separate inventory row.
  assert.equal(prisma.state.stockMovements.length, 0);
});

test("products delete removes the product only when there are no references and records the delete audit", async () => {
  const product = makeProduct({ id: "prod1aaaaaaaaaaaaaaaaaaa", name: "Widget", quantity: 10 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [product],
    inventory: [],
  });

  const route = loadRoute("src/app/api/products/route.ts", makeModuleMocks({ prisma }));
  const response = await route.DELETE(makeRequest({ id: "prod1aaaaaaaaaaaaaaaaaaa" }, "product-delete-success-key"));

  assert.equal(response.status, 200);
  const json = await response.json();
  assert.equal(json.ok, true);
  assert.equal(prisma.state.products.has("prod1aaaaaaaaaaaaaaaaaaa"), false);
  // inventory model was merged into Product.quantity (commit 42085b00);
  // the delete path now removes the product row, not a separate inventory row.
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  assert.equal(prisma.state.criticalWriteEvents[0].actionType, "product.delete");
});

test("logRouteError emits structured failure context", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
  });

  const originalError = console.error;
  const seen = [];
  console.error = (...args) => {
    seen.push(args);
  };

  try {
    const routeHelpers = loadRoute("src/app/api/_lib/route-helpers.ts", makeModuleMocks({ prisma }));
    const boom = new Error("boom");
    routeHelpers.logRouteError("sales/create", boom, {
      businessId: "biz1aaaaaaaaaaaaaaaaaaaa",
      actionType: "sale.create",
    });

    assert.equal(seen.length, 1);
    const payload = JSON.parse(seen[0][0]);
    // logRouteError routes through cloudLog — field names follow Cloud Logging convention
    assert.equal(payload.severity, "ERROR");
    assert.equal(payload.action, "sales/create");
    assert.equal(payload.data.businessId, "biz1aaaaaaaaaaaaaaaaaaaa");
    assert.equal(payload.data.actionType, "sale.create");
    assert.deepEqual(payload.data.error, {
      name: "Error",
      message: "boom",
      stack: boom.stack,
    });
    assert.ok(typeof payload.timestamp === "string" && payload.timestamp.length > 0);
  } finally {
    console.error = originalError;
  }
});

test("critical user-facing errors and dashboard mutation fallbacks stay in Spanish", async () => {
  const routeFiles = [
    "src/app/api/invoices/[invoiceId]/send-whatsapp/route.ts",
    "src/app/api/invoices/[invoiceId]/route.ts",
    "src/app/api/purchase-requests/[requestId]/pdf/route.ts",
    "src/app/api/purchase-requests/[requestId]/send-whatsapp/route.ts",
    "src/app/api/suppliers/route.ts",
    "src/app/api/onboarding/route.ts",
  ];

  for (const relativePath of routeFiles) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), "utf8");
    assert.doesNotMatch(
      source,
      /"Unauthorized"|"No business found"|"Invalid invoice id"|"Invalid status"|"Invalid JSON body"|"Purchase request not found"|"Invoice not found"|"Failed to [^"]+"|"item\(s\)\."|"Items: [^"]+"|"name is required"|"At least one field is required"|"Internal server error"/
    );
  }

  const hooksSource = fs.readFileSync(
    path.join(process.cwd(), "src/app/dashboard/lib/hooks.ts"),
    "utf8"
  );

  assert.doesNotMatch(
    hooksSource,
    /Failed to load business|Could not process request|Failed to save sale|Failed to update invoice status|Item and quantity are required|Unit price must be 0 or higher|Business name is required|Failed to update settings|Settings saved|Please select a product and a quantity greater than 0|Selected product not found|Type, amount, and description are required|Failed to save movement|Cash movement saved|Name, price >= 0 and stock >= 0 are required|Failed to create product|Failed to update product|Failed to delete product|Product deleted|Failed to update client|Failed to update supplier|Supplier name is required|Failed to create supplier|First name is required|Failed to create client/
  );
});

// ── products/resolve-or-create — Flujo 1 endpoint ─────────────────────────────

test("products/resolve-or-create: returns existing product (resolved=true) without writing audit or new row", async () => {
  const existing = makeProduct({ id: "prodflanaaaaaaaaaaaaaaaa", name: "Flan Casero", price: 300, quantity: 5 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [existing],
    inventory: [],
  });

  const route = loadRoute("src/app/api/products/resolve-or-create/route.ts", makeModuleMocks({ prisma }));
  // Case- and accent-insensitive lookup: user types "flan casero" but
  // catalog has "Flan Casero" — the route must resolve, not create.
  const res = await route.POST(makeRequest({ name: "flan casero", price: 999 }, "rc-key-1"));

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.resolved, true);
  assert.equal(json.product.id, "prodflanaaaaaaaaaaaaaaaa");
  assert.equal(json.product.name, "Flan Casero");
  // Existing row's price is preserved — the requested 999 is ignored on resolve.
  assert.equal(json.product.price, 300);
  assert.equal(prisma.state.products.size, 1);
  // No critical-write audit on the resolve branch (only the create branch traces).
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

test("products/resolve-or-create: creates a new product (resolved=false) with inventory and audit", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  const route = loadRoute("src/app/api/products/resolve-or-create/route.ts", makeModuleMocks({ prisma }));
  const res = await route.POST(makeRequest({ name: "Galletitas", price: 250, costPrice: 120 }, "rc-key-2"));

  assert.equal(res.status, 201);
  const json = await res.json();
  assert.equal(json.resolved, false);
  assert.equal(json.product.name, "Galletitas");
  assert.equal(json.product.price, 250);
  assert.equal(json.product.costPrice, 120);
  assert.equal(prisma.state.products.size, 1);
  // Since the Inventory model was merged into Product.quantity (commit 42085b00),
  // stock is tracked as product.quantity (default 0). No separate inventory row exists.
  const productRow = prisma.state.products.get(json.product.id);
  assert.ok(productRow, "product row missing after resolve-or-create");
  assert.equal(productRow.quantity ?? 0, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
  const event = prisma.state.criticalWriteEvents[0];
  assert.equal(event.actionType, "product.resolve-or-create");
  assert.equal(event.routeScope, "products/resolve-or-create");
  assert.equal(event.resourceType, "product");
  assert.equal(event.resourceId, json.product.id);
});

test("products/resolve-or-create: replays a duplicate submit without creating a second row or audit", async () => {
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [],
    inventory: [],
  });

  const route = loadRoute("src/app/api/products/resolve-or-create/route.ts", makeModuleMocks({ prisma }));
  const body = { name: "Yerba 1kg", price: 1500 };

  const first = await route.POST(makeRequest(body, "rc-replay-key"));
  assert.equal(first.status, 201);
  const firstJson = await first.json();

  const second = await route.POST(makeRequest(body, "rc-replay-key"));
  assert.equal(second.status, 201);
  const secondJson = await second.json();

  // Same idempotency key → cached response; no duplicate DB rows or audits.
  assert.deepEqual(secondJson, firstJson);
  assert.equal(prisma.state.products.size, 1);
  assert.equal(prisma.state.criticalWriteEvents.length, 1);
});

test("products/resolve-or-create: P2002 name collision falls back to resolve transparently", async () => {
  // The race winner the create branch will discover after P2002 fires.
  const winner = makeProduct({ id: "prodwinneraaaaaaaaaaaaaa", name: "Coca", price: 800, quantity: 0 });
  const prisma = createFakePrisma({
    business: makeBusiness(),
    products: [winner],
    inventory: [],
  });

  // Force the lookup to miss the first time so the create branch fires;
  // then have product.create throw a P2002 collision on `name`. The route
  // should re-resolve and return the winner with resolved=true.
  let lookupCalls = 0;
  const realFindMany = prisma.product.findMany;
  prisma.product.findMany = async (args) => {
    lookupCalls += 1;
    if (lookupCalls === 1) return []; // first lookup: empty → goes to create branch
    return realFindMany(args);
  };
  const realCreate = prisma.product.create;
  prisma.product.create = async () => {
    const error = new Error("Unique constraint failed on the fields: (`name`)");
    error.code = "P2002";
    error.meta = { target: ["name"] };
    throw error;
  };

  const route = loadRoute("src/app/api/products/resolve-or-create/route.ts", makeModuleMocks({ prisma }));
  const res = await route.POST(makeRequest({ name: "Coca", price: 800 }, "rc-race-key"));

  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.resolved, true);
  assert.equal(json.product.id, "prodwinneraaaaaaaaaaaaaa");
  // No audit on the resolve fallback — only the actual creator's request emits one.
  assert.equal(prisma.state.criticalWriteEvents.length, 0);

  prisma.product.findMany = realFindMany;
  prisma.product.create = realCreate;
});

test("products/resolve-or-create: rejects empty name and invalid price with 400", async () => {
  const prisma = createFakePrisma({ business: makeBusiness(), products: [], inventory: [] });
  const route = loadRoute("src/app/api/products/resolve-or-create/route.ts", makeModuleMocks({ prisma }));

  const blank = await route.POST(makeRequest({ name: "   ", price: 100 }, "rc-empty-name"));
  assert.equal(blank.status, 400);

  const negative = await route.POST(makeRequest({ name: "OK", price: -50 }, "rc-bad-price"));
  assert.equal(negative.status, 400);

  const nonNumeric = await route.POST(makeRequest({ name: "OK", price: "no-numero" }, "rc-bad-price-2"));
  assert.equal(nonNumeric.status, 400);

  // No persistence on validation failure.
  assert.equal(prisma.state.products.size, 0);
  assert.equal(prisma.state.criticalWriteEvents.length, 0);
});

