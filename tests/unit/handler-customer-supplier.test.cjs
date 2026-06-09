const assert = require("node:assert/strict");
const test = require("node:test");

const {
  handleCreateCustomer,
  handleEditCustomer,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/customer.ts");

const {
  handleCreateSupplier,
  handleEditSupplier,
} = require("../../src/app/api/business-assistant/_lib/intent-handlers/supplier.ts");

function makeParams(overrides = {}) {
  return {
    text: "",
    locale: "es-AR",
    safeIntent: "create_customer",
    answer: "Procesando.",
    parsed: { intent: "create_customer" },
    context: {},
    fullCatalogProducts: [],
    fullCatalogCustomers: [],
    fullCatalogSuppliers: [],
    productInfoDirectory: [],
    trace: { add: () => {}, toJSON: () => null },
    ...overrides,
  };
}

const readJson = (r) => r.json();

// ── Intent gate (returns null when intent doesn't match) ─────────────

test("handleCreateCustomer returns null for non-create_customer intents", () => {
  assert.equal(handleCreateCustomer(makeParams({ safeIntent: "register_sale" })), null);
  assert.equal(handleCreateCustomer(makeParams({ safeIntent: "edit_customer" })), null);
});

test("handleEditCustomer returns null for non-edit_customer intents", () => {
  assert.equal(handleEditCustomer(makeParams({ safeIntent: "create_customer" })), null);
  assert.equal(handleEditCustomer(makeParams({ safeIntent: "register_sale" })), null);
});

test("handleCreateSupplier returns null for non-create_supplier intents", () => {
  assert.equal(handleCreateSupplier(makeParams({ safeIntent: "register_sale" })), null);
});

test("handleEditSupplier returns null for non-edit_supplier intents", () => {
  assert.equal(handleEditSupplier(makeParams({ safeIntent: "create_supplier" })), null);
});

// ── create_customer happy path (deterministic answer construction) ───

test("create_customer with full data produces deterministic answer", async () => {
  const res = handleCreateCustomer(makeParams({
    safeIntent: "create_customer",
    text: "agregá a Juan Pérez con teléfono 11-2345-6789, email juan@ejemplo.com, cuit 20-12345678-9",
    parsed: {
      intent: "create_customer",
      customer: { name: "Juan Pérez", phone: "11-2345-6789", email: "juan@ejemplo.com", taxId: "20-12345678-9" },
    },
  }));
  // Resolver MUST succeed and return { answer, primaryAction } for fully-
  // specified input. A NextResponse fallback would mean the deterministic
  // path silently failed — that's a bug to surface, not tolerate.
  assert.ok(res && typeof res === "object" && "primaryAction" in res,
    `expected HandlerBody with primaryAction, got: ${JSON.stringify(res)}`);
  // Answer template (2026-05): "Juan Pérez agregado como cliente. Teléfono: ..."
  // Does not start with "Listo" — the template was simplified to skip the filler.
  assert.match(res.answer, /Juan Pérez/);
  assert.match(res.answer, /Teléfono/i);
  assert.equal(res.primaryAction.type, "create_customer");
});

test("create_customer with no recognizable data produces fallback question", async () => {
  const res = handleCreateCustomer(makeParams({
    safeIntent: "create_customer",
    text: "agregá un cliente",
    parsed: { intent: "create_customer", customer: null },
  }));
  // No customer data → handler MUST return a NextResponse with a clarifying
  // question. Returning null or a primaryAction here would be a regression.
  assert.ok(res && typeof res === "object" && "json" in res,
    `expected NextResponse clarification, got: ${JSON.stringify(res)}`);
  const data = await readJson(res);
  assert.ok(data.answer, "should ask a clarifying question");
});

test("create_customer with phone only (no name) produces primary action", () => {
  const res = handleCreateCustomer(makeParams({
    safeIntent: "create_customer",
    text: "agregá cliente con teléfono 1100000000",
    parsed: {
      intent: "create_customer",
      customer: { phone: "1100000000" },
    },
  }));
  // Phone-only — must NOT ask for name, must emit primaryAction.
  assert.ok(res && typeof res === "object" && "primaryAction" in res,
    `expected HandlerBody with primaryAction, got: ${JSON.stringify(res)}`);
  assert.equal(res.primaryAction.type, "create_customer");
});

test("create_customer with name + phone (Juan scenario) produces primary action", () => {
  const res = handleCreateCustomer(makeParams({
    safeIntent: "create_customer",
    text: "agregá cliente Carlos Rossi teléfono 1100000000",
    parsed: {
      intent: "create_customer",
      customer: { name: "Carlos Rossi", phone: "1100000000" },
    },
  }));
  assert.ok(res && typeof res === "object" && "primaryAction" in res,
    `expected HandlerBody with primaryAction, got: ${JSON.stringify(res)}`);
  assert.equal(res.primaryAction.type, "create_customer");
  assert.match(res.answer, /Carlos Rossi/);
});

// ── create_supplier happy path ───────────────────────────────────────

test("create_supplier with name produces primary action", () => {
  const res = handleCreateSupplier(makeParams({
    safeIntent: "create_supplier",
    text: "agregá proveedor Distribuidora ABC",
    parsed: { intent: "create_supplier", supplier: { name: "Distribuidora ABC" } },
  }));
  // With a parsed supplier name, handler MUST emit a primaryAction. Falling
  // back to a NextResponse clarification would mean the resolver lost the name.
  assert.ok(res && typeof res === "object" && "primaryAction" in res,
    `expected HandlerBody with primaryAction, got: ${JSON.stringify(res)}`);
  assert.equal(res.primaryAction.type, "create_supplier");
});

test("create_supplier without name asks for name", async () => {
  const res = handleCreateSupplier(makeParams({
    safeIntent: "create_supplier",
    text: "agregá un proveedor",
    parsed: { intent: "create_supplier", supplier: null },
  }));
  // No supplier name → MUST be a NextResponse clarification asking for the name.
  assert.ok(res && typeof res === "object" && "json" in res,
    `expected NextResponse clarification, got: ${JSON.stringify(res)}`);
  const data = await readJson(res);
  assert.match(data.answer, /nombre.*proveedor/i);
});
