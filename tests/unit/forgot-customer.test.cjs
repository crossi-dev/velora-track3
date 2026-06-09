const assert = require("node:assert/strict");
const test = require("node:test");

const {
  looksLikeSaleWithForgottenCustomer,
} = require("../../src/app/api/business-assistant/_lib/handlers/forgot-customer.ts");

// ── Positive: should route to customer picker ────────────────────────

test("classic 'no recuerdo' + 'vendí'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí 3 clavos, no recuerdo a quién"),
    true
  );
});

test("'no me acuerdo'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("cobré 500, no me acuerdo del cliente"),
    true
  );
});

test("'no sé a quien'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí clavos, no sé a quien"),
    true
  );
});

test("Argentine slang 'no me sale'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí una bolsa, no me sale el nombre"),
    true
  );
});

test("'ni idea'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí tres sandías, ni idea quién era"),
    true
  );
});

test("'se me olvidó'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("cobré $500 y se me olvidó el cliente"),
    true
  );
});

test("'sin cliente'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("facturá 2 clavos sin cliente"),
    true
  );
});

test("'a alguien'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí a alguien 3 bolsas"),
    true
  );
});

test("'a un cliente'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí clavos a un cliente"),
    true
  );
});

test("'olvidé el nombre'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí 3 peras, olvidé el nombre"),
    true
  );
});

test("accent-insensitive 'olvide a quien'", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí papas olvide a quien"),
    true
  );
});

// ── Negative: should NOT route to picker ─────────────────────────────

test("sale with named customer Juan → false", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí 3 clavos a Juan"),
    false
  );
});

test("sale with named customer María + 'no recuerdo cuánto' → false", () => {
  // Named customer present, 'no recuerdo' refers to quantity not customer
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí a María pero no recuerdo cuánto"),
    false
  );
});

test("no sale context → false", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("no recuerdo dónde dejé las llaves"),
    false
  );
});

test("no forgot context → false", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí 3 clavos"),
    false
  );
});

test("empty text → false", () => {
  assert.equal(looksLikeSaleWithForgottenCustomer(""), false);
});

test("allows 'a un cliente' (generic placeholder)", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí 5 papas a un cliente"),
    true
  );
});

test("allows 'a una persona' (generic placeholder)", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí 5 papas a una persona"),
    true
  );
});
