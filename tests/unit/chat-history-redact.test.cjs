const assert = require("node:assert/strict");
const test = require("node:test");

const { redactPii } = require("../../src/lib/chat-history-redact.ts");

// ── Invoice / document numbers MUST NOT be redacted ────────────────
//
// Before this fix, GENERIC_PHONE_RE matched invoice numbers like
// "0001-00000090" (two 4-digit groups separated by hyphen) and redacted
// them to "[tel]". The resulting "REC-[tel]" text in the DB didn't
// match the local unredacted "REC-0001-00000090", so the chat-history
// dedup skipped and rendered the success message twice on reload.

test("REC invoice number is NOT redacted", () => {
  const input = "Venta a Carlos Rossi — ARS 968.00. Comprobante: REC-0001-00000090.";
  assert.equal(redactPii(input), input);
});

test("FC invoice number is NOT redacted", () => {
  const input = "Factura FC-0001-00000042 emitida.";
  assert.equal(redactPii(input), input);
});

test("PRES budget number is NOT redacted", () => {
  const input = "Presupuesto PRES-0001-00000007 listo.";
  assert.equal(redactPii(input), input);
});

// ── Actual phone numbers ARE still redacted ────────────────────────

test("Argentine +54 phone is redacted", () => {
  const input = "Llamame al +54 9 11 2345-6789 más tarde.";
  const out = redactPii(input);
  assert.ok(out.includes("[tel]"));
  assert.ok(!out.includes("11 2345-6789"));
});

test("generic 10-digit phone is redacted", () => {
  const input = "Mi teléfono es 11-2345-6789 gracias.";
  const out = redactPii(input);
  assert.ok(out.includes("[tel]"));
  assert.ok(!out.includes("2345-6789"));
});

test("Spanish 'Tel: 1134567890' is redacted (CUIT_RE catches 10-digit runs first)", () => {
  // 10 consecutive digits also fit a CUIT shape (AA-BBBBBBBB-C without
  // separators) so CUIT_RE wins over GENERIC_PHONE_RE. Either placeholder
  // is acceptable — what matters is that the digits don't leak through.
  const input = "Tel: 1134567890";
  const out = redactPii(input);
  assert.ok(out.includes("[tel]") || out.includes("[cuit]"));
  assert.ok(!out.includes("1134567890"));
});

// ── CUIT still redacted (when not prefixed with invoice marker) ────

test("standalone CUIT is redacted", () => {
  const input = "CUIT 20-12345678-9";
  const out = redactPii(input);
  assert.ok(out.includes("[cuit]"));
  assert.ok(!out.includes("12345678"));
});

test("CUIT prefixed by REC- is not redacted (edge — shouldn't happen, but safe)", () => {
  const input = "REC-20-12345678-9 (weird format)";
  assert.equal(redactPii(input), input);
});

// ── Emails still redacted ───────────────────────────────────────────

test("email is redacted", () => {
  const input = "contactame a juan@example.com";
  const out = redactPii(input);
  assert.ok(out.includes("[email]"));
  assert.ok(!out.includes("juan@"));
});

// ── Mixed content ──────────────────────────────────────────────────

test("realistic sale-success message preserves invoice, redacts phone", () => {
  const input = "Venta a Carlos — REC-0001-00000090. Llamar al 11-2345-6789.";
  const out = redactPii(input);
  assert.ok(out.includes("REC-0001-00000090"), "invoice preserved");
  assert.ok(out.includes("[tel]"), "phone redacted");
});
