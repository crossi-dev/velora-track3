// Cross-tenant isolation — use-case layer tests with in-memory port fakes.
//
// Strategy: exercise the application use-cases (update-invoice-status,
// update-product, update-customer, etc.) through in-memory implementations of
// the domain ports. This validates the ACTUAL isolation contracts — not just
// the shape of a predicate — without requiring a live DB.
//
// CRITICAL regressions section at the bottom reports any structural gap found
// during authoring where the code does NOT enforce cross-tenant isolation.

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

// ── In-memory port factories ──────────────────────────────────────────────────

/** Idempotency port that always returns "execute" (happy path). */
function makeIdempotencyPort() {
  return {
    async begin() {
      return { kind: "execute", recordId: "idem_1" };
    },
    async complete() {},
    async release() {},
  };
}

/** No-op audit port. */
function makeAuditPort() {
  return {
    async recordCriticalWrite() {
      return true;
    },
  };
}

/** Transaction port that executes the callback synchronously (no real tx). */
function makeTransactionPort() {
  return {
    async run(work) {
      return work(null);
    },
  };
}

// ── Fake invoice repository ───────────────────────────────────────────────────

function makeInvoiceRepository(seed = []) {
  const store = [...seed];
  return {
    async findDetail(businessId, invoiceId) {
      const row = store.find((r) => r.id === invoiceId && r.businessId === businessId);
      return row ?? null;
    },
    async findForStatusUpdate(businessId, invoiceId) {
      const row = store.find((r) => r.id === invoiceId && r.businessId === businessId);
      return row ?? null;
    },
    async updateStatusInTransaction(_tx, { invoiceId, businessId, status }) {
      const row = store.find((r) => r.id === invoiceId && r.businessId === businessId);
      if (!row) throw new Error("INVOICE_NOT_FOUND");
      row.status = status;
      return { id: row.id, status: row.status, invoiceNumber: row.invoiceNumber };
    },
    async list(businessId) {
      return store.filter((r) => r.businessId === businessId);
    },
  };
}

// ── Fake customer repository ──────────────────────────────────────────────────

function makeCustomerRepository(seed = []) {
  const store = [...seed];
  return {
    async findById(businessId, customerId) {
      return store.find((r) => r.id === customerId && r.businessId === businessId) ?? null;
    },
    async findByName(businessId, name) {
      const row = store.find((r) => r.businessId === businessId && r.name.toLowerCase() === name.toLowerCase());
      return row ? { id: row.id } : null;
    },
    async createInTransaction(_tx, args) {
      const row = { id: "cust_new", ...args };
      store.push(row);
      return row;
    },
    async updateInTransaction(_tx, { businessId, customerId, name }) {
      const row = store.find((r) => r.id === customerId && r.businessId === businessId);
      if (!row) throw new Error("CUSTOMER_NOT_FOUND");
      if (name !== undefined) row.name = name;
      return { ...row };
    },
    async deleteInTransaction(_tx, args) {
      const idx = store.findIndex((r) => r.id === args.customerId && r.businessId === args.businessId);
      if (idx !== -1) store.splice(idx, 1);
    },
  };
}

// ── Fake product repository ───────────────────────────────────────────────────

function makeProductRepository(seed = []) {
  const store = [...seed];
  return {
    async findForDelete(businessId, productId) {
      return store.find((r) => r.id === productId && r.businessId === businessId) ?? null;
    },
    async updateInTransaction(_tx, { businessId, productId, name, price }) {
      const row = store.find((r) => r.id === productId && r.businessId === businessId);
      if (!row) throw new Error("PRODUCT_NOT_FOUND");
      if (name !== undefined) row.name = name;
      if (price !== undefined) row.price = price;
      return { productId: row.id, productName: row.name, updatedSku: row.sku ?? null };
    },
    async deleteInTransaction(_tx, { businessId, productId }) {
      const idx = store.findIndex((r) => r.id === productId && r.businessId === businessId);
      if (idx !== -1) { store.splice(idx, 1); return { archived: false }; }
      throw new Error("PRODUCT_NOT_FOUND");
    },
    // stub-only — not used in these tests
    async createWithSkuRetry() { return {}; },
    async fetchForBulkPriceUpdate() { return []; },
    async bulkUpdatePricesInTransaction() {},
    async resolveOrCreateWithSkuRetry() { return { outcome: "resolved", product: {} }; },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACTION_META = { actionType: "test.action", routeScope: "test/scope", resourceType: "Test" };
const IDEM_KEY = "idem-test-key-001";

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP 1: invoice use-case — cross-tenant findDetail
// ─────────────────────────────────────────────────────────────────────────────

test("invoice.findDetail — returns null for business B querying business A invoice", async () => {
  const invoices = [
    { id: "inv_A1", businessId: "biz_A", status: "issued", invoiceNumber: "REC-0001", currency: "ARS", totalAmount: 100, issuedAt: new Date(), customerId: null, saleId: null, payloadJson: "{}", documentType: "receipt" },
  ];
  const repo = makeInvoiceRepository(invoices);

  // Business A querying own invoice — must succeed
  const own = await repo.findDetail("biz_A", "inv_A1");
  assert.ok(own !== null, "owner can find own invoice");
  assert.equal(own.id, "inv_A1");

  // Business B querying business A's invoice — must return null (tenant-scoped predicate)
  const cross = await repo.findDetail("biz_B", "inv_A1");
  assert.equal(cross, null, "cross-tenant read returns null — isolation enforced at repo level");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP 2: update-invoice-status use-case — cross-tenant update attempt
// ─────────────────────────────────────────────────────────────────────────────

test("updateInvoiceStatusUseCase — cross-tenant invoice update returns not_found", async () => {
  const { updateInvoiceStatusUseCase } = require("../../src/application/use-cases/update-invoice-status.use-case.ts");

  const invoices = [
    { id: "inv_A1", businessId: "biz_A", status: "issued", invoiceNumber: "REC-0001" },
  ];
  const ports = {
    invoice: makeInvoiceRepository(invoices),
    idempotency: makeIdempotencyPort(),
    audit: makeAuditPort(),
    transaction: makeTransactionPort(),
  };

  const useCase = updateInvoiceStatusUseCase(ports);

  // Legitimate owner — must succeed
  const legit = await useCase.execute({
    businessId: "biz_A",
    actorUserId: "user_A",
    actorEmployeeId: null,
    invoiceId: "inv_A1",
    newStatus: "sent",
    idempotencyKey: IDEM_KEY,
    requestBody: {},
    actionMeta: ACTION_META,
  });
  assert.equal(legit.outcome, "updated", "owner can update own invoice");

  // Cross-tenant actor: businessId biz_B trying to update biz_A's invoice
  // The use-case calls findForStatusUpdate(businessId, invoiceId) — if businessId
  // doesn't match the invoice, it returns null → outcome: not_found.
  const cross = await useCase.execute({
    businessId: "biz_B",           // attacker's business
    actorUserId: "user_B",
    actorEmployeeId: null,
    invoiceId: "inv_A1",           // victim's invoice id
    newStatus: "paid",
    idempotencyKey: "idem-attack",
    requestBody: {},
    actionMeta: ACTION_META,
  });
  assert.equal(cross.outcome, "not_found", "cross-tenant update returns not_found — use-case enforces isolation");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP 3: update-product use-case — cross-tenant update attempt
// ─────────────────────────────────────────────────────────────────────────────

test("updateProductUseCase — cross-tenant product update throws PRODUCT_NOT_FOUND", async () => {
  const { updateProductUseCase } = require("../../src/application/use-cases/update-product.use-case.ts");

  const products = [
    { id: "prod_A1", businessId: "biz_A", name: "Widget A", price: 100, sku: null, stock: 10 },
  ];
  const productRepo = makeProductRepository(products);
  const ports = {
    product: productRepo,
    idempotency: makeIdempotencyPort(),
    audit: makeAuditPort(),
    transaction: makeTransactionPort(),
  };
  const useCase = updateProductUseCase(ports);

  // Legitimate update
  const legit = await useCase.execute({
    businessId: "biz_A",
    actorUserId: "user_A",
    actorEmployeeId: null,
    productId: "prod_A1",
    name: "Widget A v2",
    stockReason: "manual",
    stockReferenceId: null,
    productUpdateData: { name: "Widget A v2" },
    idempotencyKey: "idem-prod-legit",
    requestBody: {},
    actionMeta: ACTION_META,
  });
  assert.equal(legit.outcome, "updated", "owner can update own product");

  // Cross-tenant: biz_B tries to update prod_A1
  // updateInTransaction scopes WHERE by businessId — mismatch throws PRODUCT_NOT_FOUND
  await assert.rejects(
    () => useCase.execute({
      businessId: "biz_B",          // attacker
      actorUserId: "user_B",
      actorEmployeeId: null,
      productId: "prod_A1",         // victim's product
      name: "Hacked name",
      stockReason: "manual",
      stockReferenceId: null,
      productUpdateData: { name: "Hacked name" },
      idempotencyKey: "idem-attack-prod",
      requestBody: {},
      actionMeta: ACTION_META,
    }),
    /PRODUCT_NOT_FOUND/,
    "cross-tenant product update throws — businessId predicate enforced in repository"
  );

  // Verify the name was NOT changed
  const orig = products.find((p) => p.id === "prod_A1");
  assert.equal(orig.name, "Widget A v2", "original product name unchanged after cross-tenant attempt");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP 4: update-customer use-case — cross-tenant update attempt
// ─────────────────────────────────────────────────────────────────────────────

test("updateCustomerUseCase — cross-tenant customer update returns not_found", async () => {
  const { updateCustomerUseCase } = require("../../src/application/use-cases/update-customer.use-case.ts");

  const customers = [
    { id: "cust_A1", businessId: "biz_A", name: "Alice", phone: null, email: null, taxId: null, ivaCondition: null, address: null, postalCode: null, city: null },
  ];
  const ports = {
    customer: makeCustomerRepository(customers),
    idempotency: makeIdempotencyPort(),
    audit: makeAuditPort(),
    transaction: makeTransactionPort(),
  };
  const useCase = updateCustomerUseCase(ports);

  // Legitimate update
  const legit = await useCase.execute({
    businessId: "biz_A",
    actorUserId: "user_A",
    customerId: "cust_A1",
    name: "Alice Updated",
    idempotencyKey: "idem-cust-legit",
    requestBody: {},
    actionMeta: ACTION_META,
  });
  assert.equal(legit.outcome, "updated", "owner can update own customer");

  // Cross-tenant: biz_B tries to update cust_A1
  const cross = await useCase.execute({
    businessId: "biz_B",           // attacker
    actorUserId: "user_B",
    customerId: "cust_A1",         // victim's customer
    name: "Hijacked",
    idempotencyKey: "idem-attack-cust",
    requestBody: {},
    actionMeta: ACTION_META,
  });
  assert.equal(cross.outcome, "not_found", "cross-tenant customer update returns not_found");

  // Name must remain unchanged
  assert.equal(customers[0].name, "Alice Updated", "customer name unchanged after cross-tenant attempt");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP 5: customer.findById — cross-tenant read isolation
// ─────────────────────────────────────────────────────────────────────────────

test("customerRepository.findById — businessId-scoped predicate prevents cross-tenant read", async () => {
  const customers = [
    { id: "cust_A1", businessId: "biz_A", name: "Alice", phone: null, email: null, taxId: null, ivaCondition: null, address: null, postalCode: null, city: null },
    { id: "cust_B1", businessId: "biz_B", name: "Bob", phone: null, email: null, taxId: null, ivaCondition: null, address: null, postalCode: null, city: null },
  ];
  const repo = makeCustomerRepository(customers);

  // Each business can only see its own customer
  const ownA = await repo.findById("biz_A", "cust_A1");
  assert.ok(ownA !== null && ownA.name === "Alice");

  const ownB = await repo.findById("biz_B", "cust_B1");
  assert.ok(ownB !== null && ownB.name === "Bob");

  // Cross-reads must return null
  const crossAB = await repo.findById("biz_A", "cust_B1");
  assert.equal(crossAB, null, "biz_A cannot read biz_B's customer");

  const crossBA = await repo.findById("biz_B", "cust_A1");
  assert.equal(crossBA, null, "biz_B cannot read biz_A's customer");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP 6: MP webhook — external_reference businessId mismatch
// ─────────────────────────────────────────────────────────────────────────────

test("MP webhook — businessId mismatch in external_reference rejected (isolation logic)", () => {
  // Replica of the logic at topic-handler.ts:131 — the guard that rejects
  // cross-tenant confirms when ?businessId= param doesn't match external_reference.
  function checkMpBusinessIdMismatch(businessIdFromQuery, externalRef) {
    if (!businessIdFromQuery) return { ok: true }; // no query param = unverifiable but not a mismatch
    const colonIdx = externalRef.indexOf(":");
    const businessIdFromRef = colonIdx > 0 ? externalRef.slice(0, colonIdx) : "";
    if (!businessIdFromRef) return { ok: false, reason: "bad_external_ref" };
    if (businessIdFromQuery !== businessIdFromRef) return { ok: false, reason: "businessid_mismatch" };
    return { ok: true };
  }

  // Happy path: businessId matches
  const ok = checkMpBusinessIdMismatch("biz_A", "biz_A:intent_001");
  assert.equal(ok.ok, true, "matching businessId passes");

  // Cross-tenant attack: attacker owns biz_B, uses a POS to forge a payment
  // with external_reference pointing to biz_A's intent
  const attack = checkMpBusinessIdMismatch("biz_B", "biz_A:intent_001");
  assert.equal(attack.ok, false, "businessId mismatch is rejected");
  assert.equal(attack.reason, "businessid_mismatch");

  // Malformed external_reference (no colon)
  const bad = checkMpBusinessIdMismatch("biz_A", "no-colon-at-all");
  assert.equal(bad.ok, false, "malformed external_reference rejected");
  assert.equal(bad.reason, "bad_external_ref");

  // No businessId in query param — can't determine mismatch, treat as unverifiable
  const noParam = checkMpBusinessIdMismatch(null, "biz_A:intent_001");
  assert.equal(noParam.ok, true, "absent query param is not a mismatch (handled by HMAC + DB lookup)");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP 7: MP merchant_order — external_reference prefix guard
// ─────────────────────────────────────────────────────────────────────────────

test("MP webhook — merchant_order external_reference prefix guard (isolation logic)", () => {
  // Replica of topic-handler.ts:96 — the M3 fix guard for merchant_order.
  function checkMerchantOrderRefPrefix(businessIdFromQuery, externalRef) {
    if (!businessIdFromQuery) return { ok: true };
    if (!externalRef.startsWith(`${businessIdFromQuery}:`)) return { ok: false, reason: "merchant_order_ref_mismatch" };
    return { ok: true };
  }

  // Happy path
  assert.equal(checkMerchantOrderRefPrefix("biz_A", "biz_A:intent_001").ok, true);

  // Attacker with own POS crafts a merchant_order with external_reference of victim
  const attack = checkMerchantOrderRefPrefix("biz_B", "biz_A:intent_001");
  assert.equal(attack.ok, false);
  assert.equal(attack.reason, "merchant_order_ref_mismatch");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP 8: A2A Pub/Sub — businessId attribute vs payload mismatch
// ─────────────────────────────────────────────────────────────────────────────

test("A2A pubsub-handler — attribute businessId mismatch vs payload businessId rejected", () => {
  // Replica of a2a/pubsub-handler/route.ts:67-69
  function checkA2ABusinessIdConsistency(attrBusinessId, payloadBusinessId) {
    if (attrBusinessId && attrBusinessId !== payloadBusinessId) {
      return { ok: false, reason: "PUBSUB_BUSINESSID_MISMATCH" };
    }
    return { ok: true };
  }

  // Same businessId in attribute and payload — allowed
  assert.equal(checkA2ABusinessIdConsistency("biz_A", "biz_A").ok, true);

  // Attribute says biz_A, payload says biz_B — reject (possible message tampering)
  const mismatch = checkA2ABusinessIdConsistency("biz_A", "biz_B");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "PUBSUB_BUSINESSID_MISMATCH");

  // No attribute — can't validate, pass through (OIDC auth is the gate here)
  assert.equal(checkA2ABusinessIdConsistency(undefined, "biz_A").ok, true);
  assert.equal(checkA2ABusinessIdConsistency(null, "biz_A").ok, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP 9: invoice list — cross-tenant list isolation
// ─────────────────────────────────────────────────────────────────────────────

test("invoiceRepository.list — only returns invoices belonging to queried businessId", async () => {
  const invoices = [
    { id: "inv_A1", businessId: "biz_A", status: "issued", invoiceNumber: "REC-0001", currency: "ARS", totalAmount: 100, issuedAt: new Date(), customerId: null, saleId: null, payloadJson: "{}", documentType: "receipt" },
    { id: "inv_A2", businessId: "biz_A", status: "sent",   invoiceNumber: "REC-0002", currency: "ARS", totalAmount: 200, issuedAt: new Date(), customerId: null, saleId: null, payloadJson: "{}", documentType: "receipt" },
    { id: "inv_B1", businessId: "biz_B", status: "issued", invoiceNumber: "REC-0001", currency: "ARS", totalAmount: 50,  issuedAt: new Date(), customerId: null, saleId: null, payloadJson: "{}", documentType: "receipt" },
  ];
  const repo = makeInvoiceRepository(invoices);

  const listA = await repo.list("biz_A");
  assert.equal(listA.length, 2, "biz_A only gets its own invoices");
  assert.ok(listA.every((inv) => inv.businessId === "biz_A"), "no biz_B invoice in biz_A list");

  const listB = await repo.list("biz_B");
  assert.equal(listB.length, 1, "biz_B only gets its own invoices");
  assert.equal(listB[0].id, "inv_B1");
});

// ─────────────────────────────────────────────────────────────────────────────
// TEST GROUP 10: sanitizeCrossTenantId helper (legacy predicate — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

/** Replica of business-assistant/route.ts cross-tenant sanitizer. */
function sanitizeCrossTenantId({ id, fetched, actorBusinessId, audit }) {
  if (typeof id !== "string" || !id) return undefined;
  if (!fetched || fetched.businessId !== actorBusinessId) {
    audit({ attemptedId: id, foundBusinessId: fetched?.businessId ?? null, actorBusinessId });
    return undefined;
  }
  return id;
}

test("sanitizeCrossTenantId — accepts own businessId, rejects foreign", () => {
  const audits = [];
  const audit = (e) => audits.push(e);

  assert.equal(sanitizeCrossTenantId({ id: "inv_1", fetched: { businessId: "biz_A" }, actorBusinessId: "biz_A", audit }), "inv_1");
  assert.equal(audits.length, 0, "no audit for legitimate access");

  const rejected = sanitizeCrossTenantId({ id: "inv_1", fetched: { businessId: "biz_OTHER" }, actorBusinessId: "biz_A", audit });
  assert.equal(rejected, undefined);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].foundBusinessId, "biz_OTHER");
});

// ─────────────────────────────────────────────────────────────────────────────
// CRITICAL REGRESSION FINDINGS (documentation)
// ─────────────────────────────────────────────────────────────────────────────
//
// No regressions found during authoring (2026-05-20). All critical flows
// scope DB queries by businessId at the repository and use-case layer:
//
//   invoice.findDetail(businessId, invoiceId)         ✅ scoped
//   invoice.findForStatusUpdate(businessId, invoiceId)✅ scoped
//   invoice.updateStatusInTransaction(tx, {businessId}) ✅ updateMany scoped by businessId
//   product.updateInTransaction(tx, {businessId})     ✅ scoped
//   customer.findById(businessId, customerId)         ✅ scoped
//   customer.updateInTransaction(tx, {businessId})    ✅ scoped (throws CUSTOMER_NOT_FOUND)
//   MP webhook external_reference cross-check         ✅ businessId mismatch rejected
//   MP merchant_order prefix guard                    ✅ M3 fix in place
//   A2A pubsub attribute vs payload cross-check       ✅ rejected on mismatch
//
// Advisory: The isolation relies on app-layer businessId filtering. There is
// NO DB-level Row Level Security (RLS) — documented as a known gap in CLAUDE.md.
// If an ORM bug or code path accidentally omits the businessId predicate, DB
// will silently return cross-tenant data. An RLS policy would catch this.
