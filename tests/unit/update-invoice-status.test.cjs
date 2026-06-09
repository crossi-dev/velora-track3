const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseVeloraCommand: _parseVeloraCommand,
} = require("../../src/app/dashboard/lib/parse-velora-command.ts");
const {
  parseVeloraCommandLegacy,
} = require("../../src/app/dashboard/lib/velora-command-parser.ts");

function legacyToV2Match(c) {
  return { kind: "match", confidence: 0.5, signals: [], intent: c.intent, data: c.data };
}

function unwrapResult(r, args) {
  if (r.kind === "ambiguous") {
    return { kind: "match", confidence: r.confidence, signals: r.signals, ...r.bestGuess };
  }
  if (r.kind === "compound") {
    return { kind: "compound", commands: r.commands.map((c) => unwrapResult(c, args)) };
  }
  if (r.kind === "no-match") {
    const legacy = parseVeloraCommandLegacy(...args);
    if (legacy.matched) {
      if ("compound" in legacy) {
        return { kind: "compound", commands: legacy.commands.map(legacyToV2Match) };
      }
      return legacyToV2Match(legacy);
    }
  }
  return r;
}

function parseVeloraCommand(...args) {
  return unwrapResult(_parseVeloraCommand(...args), args);
}
const {
  buildUpdateInvoiceStatusConfirmMessage,
  resolveInvoiceByQuery,
} = require("../../src/app/dashboard/lib/command-parsers/update-invoice-status.ts");

const NO_PRODUCTS = [];
const NO_CUSTOMERS = [];

// ── Parser ─────────────────────────────────────────────────────────

test("'marcá la factura 0034 como pagada' → paid", () => {
  const r = parseVeloraCommand("marcá la factura 0034 como pagada", NO_PRODUCTS, NO_CUSTOMERS);
  if (r.kind === "match" && r.intent === "update_invoice_status") {
    assert.equal(r.data.invoiceNumberQuery, "0034");
    assert.equal(r.data.status, "paid");
  } else {
    assert.fail("expected update_invoice_status");
  }
});

test("'marcá la factura 2024-001 como enviada' → sent", () => {
  const r = parseVeloraCommand("marcá la factura 2024-001 como enviada", NO_PRODUCTS, NO_CUSTOMERS);
  if (r.kind === "match" && r.intent === "update_invoice_status") {
    assert.equal(r.data.invoiceNumberQuery, "2024-001");
    assert.equal(r.data.status, "sent");
  } else {
    assert.fail("expected update_invoice_status");
  }
});

test("'la factura 0034 ya cobré' → paid (verb inference)", () => {
  const r = parseVeloraCommand("la factura 0034 ya cobré", NO_PRODUCTS, NO_CUSTOMERS);
  if (r.kind === "match" && r.intent === "update_invoice_status") {
    assert.equal(r.data.status, "paid");
  } else {
    assert.fail("expected update_invoice_status");
  }
});

test("'factura 0034 pagada' → paid (short form)", () => {
  const r = parseVeloraCommand("factura 0034 pagada", NO_PRODUCTS, NO_CUSTOMERS);
  if (r.kind === "match" && r.intent === "update_invoice_status") {
    assert.equal(r.data.status, "paid");
  } else {
    assert.fail("expected update_invoice_status");
  }
});

test("'actualizá la factura 0034 a pagada' → paid", () => {
  const r = parseVeloraCommand("actualizá la factura 0034 a pagada", NO_PRODUCTS, NO_CUSTOMERS);
  if (r.kind === "match" && r.intent === "update_invoice_status") {
    assert.equal(r.data.status, "paid");
  } else {
    assert.fail("expected update_invoice_status");
  }
});

test("'marcá la factura 0034 como xyz' → no match (unknown status)", () => {
  const r = parseVeloraCommand("marcá la factura 0034 como xyz", NO_PRODUCTS, NO_CUSTOMERS);
  if (r.kind === "match") {
    assert.notEqual(r.intent, "update_invoice_status");
  }
});

// ── resolveInvoiceByQuery ──────────────────────────────────────────

const INVOICES = [
  { id: "i1", invoiceNumber: "REC-0001-00000034", status: "issued" },
  { id: "i2", invoiceNumber: "REC-0001-00000090", status: "paid" },
  { id: "i3", invoiceNumber: "FC-0001-00000034", status: "issued" },
];

test("resolve '0034' → null (ambiguous, matches two)", () => {
  const r = resolveInvoiceByQuery("0034", INVOICES);
  assert.equal(r, null);
});

test("resolve '0090' → unique REC-0090", () => {
  const r = resolveInvoiceByQuery("0090", INVOICES);
  assert.ok(r);
  assert.equal(r.id, "i2");
});

test("resolve 'FC-0001-00000034' → unique FC match", () => {
  const r = resolveInvoiceByQuery("FC-0001-00000034", INVOICES);
  assert.ok(r);
  assert.equal(r.id, "i3");
});

test("resolve 'xxxx' → null (no match)", () => {
  const r = resolveInvoiceByQuery("xxxx", INVOICES);
  assert.equal(r, null);
});

// ── Confirm message ────────────────────────────────────────────────

test("confirm message renders invoice number + Spanish status label", () => {
  assert.ok(buildUpdateInvoiceStatusConfirmMessage("REC-0001-00000034", "paid").includes("pagada"));
  assert.ok(buildUpdateInvoiceStatusConfirmMessage("REC-0001-00000034", "sent").includes("enviada"));
  assert.ok(buildUpdateInvoiceStatusConfirmMessage("REC-0001-00000034", "issued").includes("emitida"));
});
