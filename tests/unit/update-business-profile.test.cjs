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
  buildUpdateBusinessProfileConfirmMessage,
} = require("../../src/app/dashboard/lib/command-parsers/update-business-profile.ts");

const P = [];
const C = [];

test("'cambiá el nombre del negocio a Ferretería Norte' → name", () => {
  const r = parseVeloraCommand("cambiá el nombre del negocio a Ferretería Norte", P, C);
  if (r.kind === "match" && r.intent === "update_business_profile") {
    assert.equal(r.data.field, "name");
    assert.ok(r.data.value.includes("ferreteria"));
  } else {
    assert.fail("expected update_business_profile");
  }
});

test("'el nombre del negocio es XYZ' → name", () => {
  const r = parseVeloraCommand("el nombre del negocio es XYZ", P, C);
  if (r.kind === "match" && r.intent === "update_business_profile") {
    assert.equal(r.data.field, "name");
  } else {
    assert.fail("expected update_business_profile");
  }
});

test("'el teléfono del negocio es 1122334455' → phone", () => {
  const r = parseVeloraCommand("el teléfono del negocio es 1122334455", P, C);
  if (r.kind === "match" && r.intent === "update_business_profile") {
    assert.equal(r.data.field, "phone");
    assert.equal(r.data.value, "1122334455");
  } else {
    assert.fail("expected update_business_profile");
  }
});

test("'cambiá el whatsapp a 1122334455' → phone", () => {
  const r = parseVeloraCommand("cambiá el whatsapp a 1122334455", P, C);
  if (r.kind === "match" && r.intent === "update_business_profile") {
    assert.equal(r.data.field, "phone");
  } else {
    assert.fail("expected update_business_profile");
  }
});

test("'la dirección del negocio es Av. Corrientes 1234' → address", () => {
  const r = parseVeloraCommand("la dirección del negocio es Av. Corrientes 1234", P, C);
  if (r.kind === "match" && r.intent === "update_business_profile") {
    assert.equal(r.data.field, "address");
    assert.ok(r.data.value.includes("corrientes"));
  } else {
    assert.fail("expected update_business_profile");
  }
});

test("'el email del negocio es contacto@xyz.com' → email", () => {
  const r = parseVeloraCommand("el email del negocio es contacto@xyz.com", P, C);
  if (r.kind === "match" && r.intent === "update_business_profile") {
    assert.equal(r.data.field, "email");
  } else {
    assert.fail("expected update_business_profile");
  }
});

test("'el CUIT del negocio es 30-12345678-9' → taxId", () => {
  const r = parseVeloraCommand("el CUIT del negocio es 30-12345678-9", P, C);
  if (r.kind === "match" && r.intent === "update_business_profile") {
    assert.equal(r.data.field, "taxId");
  } else {
    assert.fail("expected update_business_profile");
  }
});

test("confirm message labels field in Spanish", () => {
  assert.ok(buildUpdateBusinessProfileConfirmMessage({ field: "name", value: "XYZ" }).includes("nombre"));
  assert.ok(buildUpdateBusinessProfileConfirmMessage({ field: "phone", value: "11" }).includes("teléfono"));
  assert.ok(buildUpdateBusinessProfileConfirmMessage({ field: "address", value: "X" }).includes("dirección"));
  assert.ok(buildUpdateBusinessProfileConfirmMessage({ field: "taxId", value: "30" }).includes("CUIT"));
});
