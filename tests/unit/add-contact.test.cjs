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
  buildAddContactConfirmMessage,
} = require("../../src/app/dashboard/lib/command-parsers/add-contact.ts");

const P = [];
const C = [];

// ── Customer patterns ──────────────────────────────────────────────

test("'nuevo cliente juan pérez' → customer with just name", () => {
  const r = parseVeloraCommand("nuevo cliente juan pérez", P, C);
  if (r.kind === "match" && r.intent === "add_contact") {
    assert.equal(r.data.kind, "customer");
    assert.ok(r.data.name.includes("juan"));
    assert.equal(r.data.phone, null);
    assert.equal(r.data.email, null);
  } else {
    assert.fail("expected add_contact customer");
  }
});

test("'nuevo cliente juan pérez, tel 11-2345-6789' → with phone", () => {
  const r = parseVeloraCommand("nuevo cliente juan pérez, tel 11-2345-6789", P, C);
  if (r.kind === "match" && r.intent === "add_contact") {
    assert.equal(r.data.kind, "customer");
    assert.ok(r.data.phone);
    assert.ok(r.data.phone.includes("11"));
  } else {
    assert.fail("expected add_contact customer");
  }
});

test("'nuevo cliente juan, cel 1122334455, email a@b.com, cuit 20-12345678-9' → all fields", () => {
  const r = parseVeloraCommand("nuevo cliente juan, cel 1122334455, email a@b.com, cuit 20-12345678-9", P, C);
  if (r.kind === "match" && r.intent === "add_contact") {
    assert.equal(r.data.kind, "customer");
    assert.ok(r.data.phone);
    assert.ok(r.data.email);
    assert.ok(r.data.taxId);
  } else {
    assert.fail("expected add_contact customer");
  }
});

test("'agregá a juan como cliente' → alternate phrasing", () => {
  const r = parseVeloraCommand("agregá a juan como cliente", P, C);
  if (r.kind === "match" && r.intent === "add_contact") {
    assert.equal(r.data.kind, "customer");
    assert.equal(r.data.name, "juan");
  } else {
    assert.fail("expected add_contact customer");
  }
});

// ── Supplier patterns ──────────────────────────────────────────────

test("'nuevo proveedor ferretería xyz' → supplier", () => {
  const r = parseVeloraCommand("nuevo proveedor ferretería xyz", P, C);
  if (r.kind === "match" && r.intent === "add_contact") {
    assert.equal(r.data.kind, "supplier");
    assert.ok(r.data.name.includes("ferreteria"));
  } else {
    assert.fail("expected add_contact supplier");
  }
});

test("'nuevo proveedor xyz, contacto pedro, tel 11-2345' → with contact name", () => {
  const r = parseVeloraCommand("nuevo proveedor xyz, contacto pedro, tel 11-2345", P, C);
  if (r.kind === "match" && r.intent === "add_contact") {
    assert.equal(r.data.kind, "supplier");
    assert.equal(r.data.contactName, "pedro");
    assert.ok(r.data.phone);
  } else {
    assert.fail("expected add_contact supplier");
  }
});

test("'agregá al proveedor abc' → al (contracted) article", () => {
  const r = parseVeloraCommand("agregá al proveedor abc", P, C);
  if (r.kind === "match" && r.intent === "add_contact") {
    assert.equal(r.data.kind, "supplier");
    assert.equal(r.data.name, "abc");
  } else {
    assert.fail("expected add_contact supplier");
  }
});

// ── Null-resolution fall-through ───────────────────────────────────

test("'nuevo cliente 11-2345' → name is all-digits, falls through to AI", () => {
  const r = parseVeloraCommand("nuevo cliente 11-2345", P, C);
  if (r.kind === "match") {
    assert.notEqual(r.intent, "add_contact");
  }
});

test("'nuevo cliente' alone → no match", () => {
  const r = parseVeloraCommand("nuevo cliente", P, C);
  if (r.kind === "match") {
    assert.notEqual(r.intent, "add_contact");
  }
});

// ── Confirm message ───────────────────────────────────────────────

test("customer confirm message includes name and kind label", () => {
  const msg = buildAddContactConfirmMessage({
    kind: "customer",
    name: "Juan Pérez",
    phone: "11-2345",
    email: null,
    taxId: null,
    contactName: null,
  });
  assert.ok(msg.includes("cliente"));
  assert.ok(msg.includes("Juan Pérez"));
  assert.ok(msg.includes("11-2345"));
});

test("supplier confirm message includes 'proveedor' and contact name", () => {
  const msg = buildAddContactConfirmMessage({
    kind: "supplier",
    name: "XYZ",
    phone: null,
    email: null,
    taxId: null,
    contactName: "Pedro",
  });
  assert.ok(msg.includes("proveedor"));
  assert.ok(msg.includes("Pedro"));
});
