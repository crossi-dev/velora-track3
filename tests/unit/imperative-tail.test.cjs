const assert = require("node:assert/strict");
const test = require("node:test");

const {
  splitProductAndCustomer,
  IMPERATIVE_TAIL_VERBS_RE,
} = require("../../src/app/dashboard/lib/command-parsers/shared.ts");

const {
  buildResidualActionWarning,
} = require("../../src/app/dashboard/lib/hooks/useAssistantChat.residualAction.ts");

// ── splitProductAndCustomer: imperative-tail rejection ──────────────

test("imperative tail trimmed from customer name (Bug A)", () => {
  const r = splitProductAndCustomer("una papas a carlos mándale whatsapp");
  assert.equal(r.productName, "una papas");
  assert.equal(r.customerName, "carlos");
});

test("imperative variant: enviale", () => {
  const r = splitProductAndCustomer("3 remeras a juan enviale el comprobante");
  assert.equal(r.productName, "3 remeras");
  assert.equal(r.customerName, "juan");
});

test("imperative variant: contactá", () => {
  const r = splitProductAndCustomer("2 sandías a maria contactá al proveedor");
  assert.equal(r.productName, "2 sandías");
  assert.equal(r.customerName, "maria");
});

test("imperative at start of candidate falls back to no-customer", () => {
  // candidate would be "mándale a juan" — no name before the imperative
  const r = splitProductAndCustomer("una papa a mándale a juan");
  assert.equal(r.customerName, null);
});

test("normal customer name without imperative still works", () => {
  const r = splitProductAndCustomer("3 remeras a juan");
  assert.equal(r.productName, "3 remeras");
  assert.equal(r.customerName, "juan");
});

test("price clause still rejected (regression)", () => {
  const r = splitProductAndCustomer("50 papas a 200");
  assert.equal(r.customerName, null);
});

// ── IMPERATIVE_TAIL_VERBS_RE direct ─────────────────────────────────

test("regex matches mándale, enviá, contactá, llamá, decile, escribile, avisá", () => {
  assert.match("hola mándale", IMPERATIVE_TAIL_VERBS_RE);
  assert.match("hola enviá", IMPERATIVE_TAIL_VERBS_RE);
  assert.match("hola contactá", IMPERATIVE_TAIL_VERBS_RE);
  assert.match("hola llamá", IMPERATIVE_TAIL_VERBS_RE);
  assert.match("hola decile", IMPERATIVE_TAIL_VERBS_RE);
  assert.match("hola escribile", IMPERATIVE_TAIL_VERBS_RE);
  assert.match("hola avisá", IMPERATIVE_TAIL_VERBS_RE);
});

test("regex does not match similar non-imperatives", () => {
  assert.doesNotMatch("juan", IMPERATIVE_TAIL_VERBS_RE);
  assert.doesNotMatch("vendí", IMPERATIVE_TAIL_VERBS_RE);
  assert.doesNotMatch("manga", IMPERATIVE_TAIL_VERBS_RE);
});

// ── buildResidualActionWarning: imperative-tail pass ────────────────

test("residual warning fires on imperative tail without conjunction (Bug A surfaced)", () => {
  const w = buildResidualActionWarning(
    "vendí una papas a carlos mándale whatsapp",
    "register_sale",
  );
  assert.ok(w);
  assert.match(w, /la venta/);
  assert.match(w, /mándale whatsapp/);
});

test("residual warning still fires on conjunction split (regression)", () => {
  const w = buildResidualActionWarning(
    "vendí 3 remeras y cargá 50 clavos",
    "register_sale",
  );
  assert.ok(w);
  assert.match(w, /cargá 50 clavos/);
});

test("residual warning returns null when no second action", () => {
  const w = buildResidualActionWarning(
    "vendí 3 remeras a juan",
    "register_sale",
  );
  assert.equal(w, null);
});
