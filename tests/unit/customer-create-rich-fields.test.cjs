// Tests for Gap 2 — customer create with DNI / address / postalCode / city.
//
// Root cause: extractCustomerFromRequest only returned {name, phone, email,
// taxId}. The Andreani shipment gate (trigger-shipment-create.ts:97-108)
// rejects if the customer row is missing dni or postalCode. The demo trigger
// "creá cliente Juan García DNI 12345678 teléfono +54 9 11 1234-5678
// domicilio Corrientes 1234 Buenos Aires CP 1043" created a customer with the full
// phone string as the value (phone extractor consumed everything) and no
// dni/address/postalCode/city at all.
//
// Fixes:
//   1. extractCustomerFromRequest: phone is truncated at next field boundary
//      (e.g. "domicilio", "CP") so it captures only the phone number.
//   2. extractDni: independent regex for 7-8 digit DNI, stored in `dni` field
//      (not taxId which is for CUIT/CUIL).
//   3. extractAddress: captures text after "domicilio"/"dirección", strips CP.
//   4. extractPostalCode: captures 4-5 digits after "CP" / "código postal".
//   5. extractCity: positional (between street number and CP) or labeled.
//   6. resolveCustomerCreateRequest passes all five new fields into the action.
//
// Covers:
//   T1 — canonical demo: full rich message → all 7 fields populated
//   T2 — phone is terminated before "domicilio" (no greedy bleed-through)
//   T3 — DNI in `dni` field, not in `taxId`
//   T4 — CUIT goes into `taxId` (not confused with dni)
//   T5 — city extracted as "Mendoza" (not "Buenos Aires CP")
//   T6 — multi-word city "Buenos Aires" extracted correctly
//   T7 — simple message (name + phone only) → dni/address/postalCode/city empty
//   T8 — resolveCustomerCreateRequest propagates all fields to action.customer

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  extractCustomerFromRequest,
} = require("../../src/app/api/business-assistant/_lib/handlers/customer-extraction.ts");

const {
  resolveCustomerCreateRequest,
} = require("../../src/app/api/business-assistant/_lib/handlers/customers.ts");

// ── T1: canonical demo — all fields ──────────────────────────────────────────

test("T1: canonical demo → name + phone + dni + address + postalCode + city all populated", () => {
  const text = "crea cliente Juan García DNI 12345678 telefono +54 9 11 1234-5678 domicilio Corrientes 1234 Buenos Aires CP 1043";
  const result = extractCustomerFromRequest(text);
  assert.ok(result, "must return an extraction result");
  assert.equal(result.name, "Juan García");
  assert.equal(result.phone, "+54 9 11 1234-5678", "phone must be terminated at 'domicilio'");
  assert.equal(result.dni, "12345678", "DNI must be captured");
  assert.ok(result.address, "address must be non-empty");
  assert.equal(result.postalCode, "5500", "postal code must be 5500");
  assert.equal(result.city, "Mendoza", "city must be 'Mendoza'");
});

// ── T2: phone terminated at "domicilio" ──────────────────────────────────────

test("T2: phone value must NOT include 'domicilio' or address text", () => {
  const text = "crea cliente Juan García telefono 1100000000 domicilio Corrientes 1234 Buenos Aires CP 1043";
  const result = extractCustomerFromRequest(text);
  assert.ok(result, "must return result");
  assert.ok(
    !result.phone?.toLowerCase().includes("domicilio"),
    `phone must not contain 'domicilio', got: ${result.phone}`,
  );
  assert.equal(result.phone, "1100000000", "phone must be just the number");
});

// ── T3: DNI stored in `dni`, not `taxId` ─────────────────────────────────────

test("T3: 'DNI 12345678' goes into dni field, taxId is empty", () => {
  const text = "crea cliente Juan García DNI 12345678";
  const result = extractCustomerFromRequest(text);
  assert.ok(result, "must return result");
  assert.equal(result.dni, "12345678", "DNI must be in .dni");
  assert.equal(result.taxId, "", "taxId must be empty (DNI is not CUIT/CUIL)");
});

// ── T4: CUIT goes into taxId (not confused with dni) ─────────────────────────

test("T4: 'CUIT 20-12345678-9' goes into taxId, dni is empty", () => {
  const text = "crea cliente Juan García CUIT 20123456789";
  const result = extractCustomerFromRequest(text);
  assert.ok(result, "must return result");
  assert.equal(result.taxId, "20123456789", "CUIT must be in .taxId");
  // CUIT is 11 digits — our DNI extractor only matches 7-8 digits, so no collision.
  assert.equal(result.dni, "", "dni must be empty for CUIT input");
});

// ── T5: city is "Mendoza" without trailing "CP" ──────────────────────────────

test("T5: city must be 'Mendoza' — no trailing 'CP' bleed", () => {
  const text = "crea cliente Juan García domicilio Corrientes 1234 Buenos Aires CP 1043";
  const result = extractCustomerFromRequest(text);
  assert.ok(result, "must return result");
  assert.equal(result.city, "Mendoza", `city must be clean 'Mendoza', got: '${result.city}'`);
  assert.ok(!result.city?.toUpperCase().includes("CP"), "city must not include 'CP'");
});

// ── T6: multi-word city "Buenos Aires" ───────────────────────────────────────

test("T6: multi-word city 'Buenos Aires' extracted correctly", () => {
  const text = "crea cliente Ana Lopez domicilio Corrientes 1234 Buenos Aires CP 1043";
  const result = extractCustomerFromRequest(text);
  assert.ok(result, "must return result");
  assert.equal(result.postalCode, "1043");
  assert.equal(result.city, "Buenos Aires", `city must be 'Buenos Aires', got: '${result.city}'`);
});

// ── T7: simple message (name + phone only) → new fields are empty strings ────

test("T7: simple 'crea cliente Juan Perez telefono 1100000000' → new fields are empty", () => {
  const text = "crea cliente Juan Perez telefono 1100000000";
  const result = extractCustomerFromRequest(text);
  assert.ok(result, "must return result");
  assert.equal(result.name, "Juan Perez");
  assert.equal(result.phone, "1100000000");
  assert.equal(result.dni, "", "dni must be empty");
  assert.equal(result.address, "", "address must be empty");
  assert.equal(result.postalCode, "", "postalCode must be empty");
  assert.equal(result.city, "", "city must be empty");
});

// ── T8: resolveCustomerCreateRequest propagates all fields ───────────────────

test("T8: resolveCustomerCreateRequest → action.customer has dni + address + postalCode + city", () => {
  const text = "crea cliente Juan García DNI 12345678 telefono +54 9 11 1234-5678 domicilio Corrientes 1234 Buenos Aires CP 1043";
  const mockParsed = { customer: null };
  const resolution = resolveCustomerCreateRequest(text, mockParsed, "es-AR", { force: true });
  assert.ok(resolution?.action, "must return an action");
  const c = resolution.action.customer;
  assert.equal(c.name, "Juan García");
  assert.equal(c.phone, "+54 9 11 1234-5678");
  assert.equal(c.dni, "12345678", "action.customer.dni must be populated");
  assert.ok(c.address, "action.customer.address must be populated");
  assert.equal(c.postalCode, "5500", "action.customer.postalCode must be 5500");
  assert.equal(c.city, "Mendoza", "action.customer.city must be 'Mendoza'");
});
