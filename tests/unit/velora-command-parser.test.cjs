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

const PRODUCTS = [
  { id: "p1", name: "Yerba Mate 1kg", sku: "YERBA-1KG", price: 6200 },
  { id: "p2", name: "Azucar 1kg", sku: "AZUCAR-1KG", price: 1800 },
  { id: "p3", name: "Clavo 2 pulgadas", sku: null, price: 150 },
];

const CUSTOMERS = [
  { id: "c1", name: "Carlos Rossi" },
  { id: "c2", name: "Juan" },
  { id: "c3", name: "María López" },
];

const AMBIGUOUS_CUSTOMERS = [
  { id: "c1", name: "Carlos Pérez" },
  { id: "c2", name: "Carlos Gómez" },
];

// ── register_sale: single item ───────────────────────────────────────

test("'vendí 2 yerba mate a carlos' → items[0] has qty 2 + product resolved", () => {
  const r = parseVeloraCommand("vendí 2 yerba mate a carlos", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.items.length, 1);
    assert.equal(r.data.items[0].quantity, 2);
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.items[0].productName, "yerba mate");
    assert.equal(r.data.customerName, "carlos");
    assert.equal(r.data.customerId, "c1");
    assert.equal(r.data.ambiguousCustomer, false);
  }
});

test("'vendí tres yerba mate a juan' → number word tres = 3", () => {
  const r = parseVeloraCommand("vendí tres yerba mate a juan", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.items[0].quantity, 3);
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.customerId, "c2");
  }
});

test("'vendo una yerba mate' → no customer, qty 1 from 'una'", () => {
  const r = parseVeloraCommand("vendo una yerba mate", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.items[0].quantity, 1);
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.customerName, null);
    assert.equal(r.data.customerId, null);
  }
});

test("'vendí 1 yerba a maría lópez' → accent-insensitive customer match", () => {
  const r = parseVeloraCommand("vendí 1 yerba a maría lópez", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.customerId, "c3");
    assert.equal(r.data.items[0].productId, "p1");
  }
});

test("'vendí 1 azúcar a juan' → accent on product name", () => {
  const r = parseVeloraCommand("vendí 1 azúcar a juan", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.items[0].productId, "p2");
  }
});

test("'facturale 5 clavos a juan' → facturale verb", () => {
  const r = parseVeloraCommand("facturale 5 clavos a juan", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.items[0].quantity, 5);
    assert.equal(r.data.items[0].productId, "p3");
    assert.equal(r.data.customerId, "c2");
  }
});

test("'anotá dos kilos de azúcar a maría' → preamble 'kilos de'", () => {
  const r = parseVeloraCommand("anotá dos kilos de azúcar a maría", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.items[0].quantity, 2);
    assert.equal(r.data.items[0].productName, "azucar");
    assert.equal(r.data.items[0].productId, "p2");
  }
});

test("'registrá cinco clavos a juan' → registrá + cinco", () => {
  const r = parseVeloraCommand("registrá cinco clavos a juan", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.items[0].quantity, 5);
    assert.equal(r.data.items[0].productId, "p3");
  }
});

test("'le vendí dos yerbas a juan' → 'le' prefix still matches", () => {
  const r = parseVeloraCommand("le vendí dos yerbas a juan", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.items[0].quantity, 2);
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.customerId, "c2");
  }
});

test("'vendí 1 xyzzy a juan' → product unknown, customer resolves", () => {
  const r = parseVeloraCommand("vendí 1 xyzzy a juan", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.items[0].productId, null);
    assert.equal(r.data.items[0].productName, "xyzzy");
    assert.equal(r.data.customerId, "c2");
  }
});

test("ambiguous customer 'carlos' → ambiguousCustomer true, customerId null", () => {
  const r = parseVeloraCommand("vendí 1 yerba a carlos", PRODUCTS, AMBIGUOUS_CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.ambiguousCustomer, true);
    assert.equal(r.data.customerId, null);
    assert.equal(r.data.items[0].productId, "p1");
  }
});

test("'hola' → not a sale command, matched false", () => {
  const r = parseVeloraCommand("hola", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "no-match");
});

test("'vendí' alone with no body → matched false", () => {
  const r = parseVeloraCommand("vendí", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "no-match");
});

test("empty text → matched false", () => {
  const r = parseVeloraCommand("", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "no-match");
});

// ── check_stock intent ───────────────────────────────────────────────

test("check_stock: 'cuántas yerbas tengo' → resolves product", () => {
  const r = parseVeloraCommand("cuántas yerbas tengo", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.productName, "yerbas");
  }
});

test("check_stock: 'hay cemento' → unresolved product still matches intent", () => {
  const r = parseVeloraCommand("hay cemento", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, null);
    assert.equal(r.data.productName, "cemento");
  }
});

test("check_stock: 'cuánto queda de azúcar' → resolves product (accent)", () => {
  const r = parseVeloraCommand("cuánto queda de azúcar", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") assert.equal(r.data.productId, "p2");
});

test("check_stock: 'stock de clavo' → resolves product", () => {
  const r = parseVeloraCommand("stock de clavo", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") assert.equal(r.data.productId, "p3");
});

test("check_stock: 'hay que llamar' → NOT matched (guard against 'hay que')", () => {
  const r = parseVeloraCommand("hay que llamar a juan", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "no-match");
});

test("check_stock: 'cuántas peras' → bare form (verb elided) resolves", () => {
  const CATALOG_WITH_PERAS = [...PRODUCTS, { id: "p4", name: "Peras", sku: null, price: 100 }];
  const r = parseVeloraCommand("cuántas peras", CATALOG_WITH_PERAS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p4");
  }
});

test("check_stock: 'cuánto vale la yerba' → NOT check_stock (price query rejected)", () => {
  const r = parseVeloraCommand("cuánto vale la yerba", PRODUCTS, CUSTOMERS);
  // Price-query words (vale/cuesta/precio) reject check_stock — server handles price queries.
  if (r.kind === "match") assert.notEqual(r.intent, "check_stock");
});

test("check_stock: 'cuanto stock de yerba hay' → strips 'stock de' preamble", () => {
  const r = parseVeloraCommand("cuanto stock de yerba hay", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productName, "yerba");
    assert.equal(r.data.productId, "p1");
  }
});

test("check_stock: 'decime el stock de yerba' → strips request verb", () => {
  const r = parseVeloraCommand("decime el stock de yerba", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p1");
  }
});

test("check_stock: 'decime el stock de palacios' → matched with null productId (unknown)", () => {
  const r = parseVeloraCommand("decime el stock de palacios", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productName, "palacios");
    assert.equal(r.data.productId, null);
  }
});

test("check_stock: 'mostrame cuantas yerbas tengo' → request verb + verb pattern", () => {
  const r = parseVeloraCommand("mostrame cuantas yerbas tengo", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p1");
  }
});

test("check_stock: 'cuantos azucar me quedan' → 'me quedan' suffix stripped", () => {
  const r = parseVeloraCommand("cuantos azucar me quedan", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p2");
    assert.ok(!r.data.productName.includes("quedan"), "productName must not include 'quedan'");
  } else {
    assert.fail("expected check_stock");
  }
});

test("check_stock: 'cuantas yerbas me quedan' → plural + me quedan resolved", () => {
  const r = parseVeloraCommand("cuantas yerbas me quedan", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p1");
    assert.ok(!r.data.productName.includes("quedan"), "productName must not include 'quedan'");
  } else {
    assert.fail("expected check_stock");
  }
});

// ── check_stock: server-migrated phrasings (phase 2d #5) ───────────

test("check_stock: 'cuánto stock tiene la yerba' → resolves product", () => {
  const r = parseVeloraCommand("cuánto stock tiene la yerba", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.productName, "yerba");
  } else {
    assert.fail("expected check_stock");
  }
});

test("check_stock: 'qué stock tiene el clavo' → resolves product", () => {
  const r = parseVeloraCommand("qué stock tiene el clavo", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p3");
  } else {
    assert.fail("expected check_stock");
  }
});

test("check_stock: 'cuántas unidades hay de azúcar' → resolves product", () => {
  const r = parseVeloraCommand("cuántas unidades hay de azúcar", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p2");
  } else {
    assert.fail("expected check_stock");
  }
});

test("check_stock: 'cuántas unidades de yerba tengo' → product in middle", () => {
  const r = parseVeloraCommand("cuántas unidades de yerba tengo", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.productName, "yerba");
  } else {
    assert.fail("expected check_stock");
  }
});

test("check_stock: '¿cuántas yerbas tengo?' → leading ¿ is stripped", () => {
  const r = parseVeloraCommand("¿cuántas yerbas tengo?", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "check_stock") {
    assert.equal(r.data.productId, "p1");
  } else {
    assert.fail("expected check_stock");
  }
});

// ── stock_load: single item ──────────────────────────────────────────

test("stock_load: 'me llegaron 50 yerbas' → quantity 50, product resolved", () => {
  const r = parseVeloraCommand("me llegaron 50 yerbas", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_load") {
    assert.equal(r.data.items.length, 1);
    assert.equal(r.data.items[0].quantity, 50);
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.items[0].unitPrice, null);
  }
});

test("stock_load: 'cargá 100 azúcares' → cargá verb, plural product", () => {
  const r = parseVeloraCommand("cargá 100 azúcares", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_load") {
    assert.equal(r.data.items[0].quantity, 100);
    assert.equal(r.data.items[0].productId, "p2");
  }
});

test("stock_load: 'entraron 20 clavos a $150' → price tail parsed", () => {
  const r = parseVeloraCommand("entraron 20 clavos a $150", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_load") {
    assert.equal(r.data.items[0].quantity, 20);
    assert.equal(r.data.items[0].unitPrice, 150);
  }
});

test("stock_load: 'ingresá cinco yerbas' → word number", () => {
  const r = parseVeloraCommand("ingresá cinco yerbas", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_load") {
    assert.equal(r.data.items[0].quantity, 5);
    assert.equal(r.data.items[0].productId, "p1");
  }
});

test("stock_load: 'vendí 2 yerbas' → is register_sale, NOT stock_load (priority)", () => {
  const r = parseVeloraCommand("vendí 2 yerbas", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "register_sale");
});

// ── edit_product intent ──────────────────────────────────────────────

test("edit_product: 'el precio de la yerba es $6500' → resolves product + new price", () => {
  const r = parseVeloraCommand("el precio de la yerba es $6500", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") {
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.newPrice, 6500);
  }
});

test("edit_product: 'actualizá el azúcar a $8000' → actualizá verb", () => {
  const r = parseVeloraCommand("actualizá el azúcar a $8000", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") {
    assert.equal(r.data.productId, "p2");
    assert.equal(r.data.newPrice, 8000);
  }
});

test("edit_product: 'el clavo sale 150' → 'sale' verb without $", () => {
  const r = parseVeloraCommand("el clavo sale 150", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") {
    assert.equal(r.data.productId, "p3");
    assert.equal(r.data.newPrice, 150);
  }
});

test("edit_product: 'subí todos los precios 10%' → routes to bulk_price_update, NOT edit_product", () => {
  const r = parseVeloraCommand("subí todos los precios 10%", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "bulk_price_update");
});

test("edit_product: 'poné el cemento a 500 pesos' → resolves", () => {
  const r = parseVeloraCommand("poné el cemento a 500 pesos", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") assert.equal(r.data.newPrice, 500);
});

test("edit_product: 'cambiá el precio de la yerba a 7000' → productName exactly 'yerba' (no 'precio de' leak)", () => {
  const r = parseVeloraCommand("cambiá el precio de la yerba a 7000", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") {
    assert.equal(r.data.productName, "yerba");
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.newPrice, 7000);
  } else {
    assert.fail("expected edit_product");
  }
});

test("edit_product: 'cambiá el precio de las yerbas a 6000' → productName 'yerbas' (plural article consumed fully)", () => {
  const r = parseVeloraCommand("cambiá el precio de las yerbas a 6000", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") {
    assert.equal(r.data.productName, "yerbas");
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.newPrice, 6000);
  } else {
    assert.fail("expected edit_product");
  }
});

test("edit_product: 'actualizá el precio del clavo a 200' → productName 'clavo' ('del' contraction stripped)", () => {
  const r = parseVeloraCommand("actualizá el precio del clavo a 200", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") {
    assert.equal(r.data.productName, "clavo");
    assert.equal(r.data.productId, "p3");
    assert.equal(r.data.newPrice, 200);
  } else {
    assert.fail("expected edit_product");
  }
});

test("edit_product: 'cambiá el precio de yerba a 6800' → productName 'yerba' (no article)", () => {
  const r = parseVeloraCommand("cambiá el precio de yerba a 6800", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") {
    assert.equal(r.data.productName, "yerba");
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.newPrice, 6800);
  } else {
    assert.fail("expected edit_product");
  }
});

test("edit_product: 'el precio de la yerba ahora es 7200' → 'ahora' between name and verb", () => {
  const r = parseVeloraCommand("el precio de la yerba ahora es 7200", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") {
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.newPrice, 7200);
  } else {
    assert.fail("expected edit_product");
  }
});

test("edit_product: 'la yerba cuesta 5000' → 'cuesta' verb", () => {
  const r = parseVeloraCommand("la yerba cuesta 5000", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") {
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.newPrice, 5000);
  } else {
    assert.fail("expected edit_product");
  }
});

test("edit_product: unknown product 'xyzzy' → matched with productId=null", () => {
  const r = parseVeloraCommand("el precio de xyzzy es 1000", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "edit_product") {
    assert.equal(r.data.productId, null);
    assert.equal(r.data.productName, "xyzzy");
    assert.equal(r.data.newPrice, 1000);
  } else {
    assert.fail("expected edit_product");
  }
});

// ── edit_product confirmation payload ────────────────────────────────

const {
  buildEditProductConfirmMessage,
} = require("../../src/app/dashboard/lib/command-parsers/edit-product.ts");

test("buildEditProductConfirmMessage: uses es-AR currency format with product name and price", () => {
  const msg = buildEditProductConfirmMessage("Yerba Mate 1kg", 6500, "ARS");
  assert.ok(msg.startsWith("¿Confirmar precio de Yerba Mate 1kg: "));
  assert.ok(msg.endsWith("?"));
  assert.ok(msg.includes("6") && msg.includes("500"));
});

test("buildEditProductConfirmMessage: falls back to ARS when currency empty", () => {
  const msg = buildEditProductConfirmMessage("Test", 100, "");
  assert.ok(msg.includes("¿Confirmar precio de Test: "));
});

// ── cash_balance intent ──────────────────────────────────────────────

test("cash_balance: 'cuánto hay en caja'", () => {
  const r = parseVeloraCommand("cuánto hay en caja", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

test("cash_balance: 'saldo de caja'", () => {
  const r = parseVeloraCommand("saldo de caja", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

test("cash_balance: 'cómo anda la caja'", () => {
  const r = parseVeloraCommand("cómo anda la caja", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

test("cash_balance: 'caja' alone", () => {
  const r = parseVeloraCommand("caja", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

test("cash_balance: 'vendí una caja de yerba' → NOT cash_balance (register_sale wins)", () => {
  const r = parseVeloraCommand("vendí una caja de yerba", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "register_sale");
});

// ── sales_summary intent ─────────────────────────────────────────────

test("sales_summary: 'cuánto vendí hoy' → period today", () => {
  const r = parseVeloraCommand("cuánto vendí hoy", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "sales_summary") assert.equal(r.data.period, "today");
});

test("sales_summary: 'ventas de hoy' → period today", () => {
  const r = parseVeloraCommand("ventas de hoy", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "sales_summary") assert.equal(r.data.period, "today");
});

test("sales_summary: 'cuánto entré esta semana' → period week", () => {
  const r = parseVeloraCommand("cuánto entré esta semana", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "sales_summary") assert.equal(r.data.period, "week");
});

test("sales_summary: 'cuánto vendí ayer' → period yesterday", () => {
  const r = parseVeloraCommand("cuánto vendí ayer", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "sales_summary") assert.equal(r.data.period, "yesterday");
});

test("sales_summary: 'resumen de ventas del mes' → period month", () => {
  const r = parseVeloraCommand("resumen de ventas del mes", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "sales_summary") assert.equal(r.data.period, "month");
});

// ── stock_adjustment intent ──────────────────────────────────────────

test("stock_adjustment: 'descontá 5 yerbas' → decrease + reason correction", () => {
  const r = parseVeloraCommand("descontá 5 yerbas", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_adjustment") {
    assert.equal(r.data.mode, "decrease");
    assert.equal(r.data.quantity, 5);
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.reason, "correction");
  }
});

test("stock_adjustment: 'rompí 2 azúcares' → decrease + breakage reason", () => {
  const r = parseVeloraCommand("rompí 2 azúcares", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_adjustment") {
    assert.equal(r.data.mode, "decrease");
    assert.equal(r.data.reason, "breakage");
    assert.equal(r.data.productId, "p2");
  }
});

test("stock_adjustment: 'ajustá yerba a 30' → set mode", () => {
  const r = parseVeloraCommand("ajustá yerba a 30", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_adjustment") {
    assert.equal(r.data.mode, "set");
    assert.equal(r.data.quantity, 30);
    assert.equal(r.data.productId, "p1");
  }
});

test("stock_adjustment: 'sumale 20 clavos' → increase mode", () => {
  const r = parseVeloraCommand("sumale 20 clavos", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_adjustment") {
    assert.equal(r.data.mode, "increase");
    assert.equal(r.data.quantity, 20);
    assert.equal(r.data.productId, "p3");
  }
});

test("stock_adjustment: 'vendí 2 yerbas' → NOT adjustment (register_sale wins)", () => {
  const r = parseVeloraCommand("vendí 2 yerbas", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "register_sale");
});

// ── bulk_price_update intent ─────────────────────────────────────────

test("bulk_price_update: 'subí todos los precios 10%' → percentage up 10", () => {
  const r = parseVeloraCommand("subí todos los precios 10%", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "bulk_price_update") {
    assert.equal(r.data.mode, "percentage");
    assert.equal(r.data.direction, "up");
    assert.equal(r.data.amount, 10);
  }
});

test("bulk_price_update: 'aumentá todo 15%' → percentage up 15", () => {
  const r = parseVeloraCommand("aumentá todo 15%", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "bulk_price_update") {
    assert.equal(r.data.direction, "up");
    assert.equal(r.data.amount, 15);
  }
});

test("bulk_price_update: 'bajá todos los precios 20%' → percentage down 20", () => {
  const r = parseVeloraCommand("bajá todos los precios 20%", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "bulk_price_update") {
    assert.equal(r.data.direction, "down");
    assert.equal(r.data.amount, 20);
  }
});

test("bulk_price_update: 'subí todos 500 pesos' → absolute up 500", () => {
  const r = parseVeloraCommand("subí todos 500 pesos", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "bulk_price_update") {
    assert.equal(r.data.mode, "absolute");
    assert.equal(r.data.direction, "up");
    assert.equal(r.data.amount, 500);
  }
});

test("bulk_price_update: 'el precio de la yerba es $6500' → NOT bulk (edit_product wins)", () => {
  const r = parseVeloraCommand("el precio de la yerba es $6500", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "edit_product");
});

// ── Multi-item + compound ────────────────────────────────────────────

test("multi-item stock_load: 'me llegaron 50 yerbas, 30 azúcares, 20 clavos'", () => {
  const r = parseVeloraCommand(
    "me llegaron 50 yerbas, 30 azúcares, 20 clavos",
    PRODUCTS,
    CUSTOMERS
  );
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_load") {
    assert.equal(r.data.items.length, 3);
    assert.equal(r.data.items[0].quantity, 50);
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.items[1].quantity, 30);
    assert.equal(r.data.items[1].productId, "p2");
    assert.equal(r.data.items[2].quantity, 20);
    assert.equal(r.data.items[2].productId, "p3");
  }
});

test("multi-item stock_load with prices: 'me llegaron 50 yerbas a $50, 30 azúcares a $10'", () => {
  const r = parseVeloraCommand(
    "me llegaron 50 yerbas a $50, 30 azúcares a $10",
    PRODUCTS,
    CUSTOMERS
  );
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_load") {
    assert.equal(r.data.items.length, 2);
    assert.equal(r.data.items[0].unitPrice, 50);
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.items[1].unitPrice, 10);
    assert.equal(r.data.items[1].productId, "p2");
  }
});

test("multi-item register_sale: 'vendí 2 yerbas y 3 azúcares a carlos'", () => {
  const r = parseVeloraCommand(
    "vendí 2 yerbas y 3 azúcares a carlos",
    PRODUCTS,
    CUSTOMERS
  );
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.items.length, 2);
    assert.equal(r.data.items[0].quantity, 2);
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.items[1].quantity, 3);
    assert.equal(r.data.items[1].productId, "p2");
    assert.equal(r.data.customerId, "c1");
  }
});

test("multi-item stock+price: 'traje yerba a $50 y frutillas a $10' → stock_load with 2 items + prices", () => {
  const r = parseVeloraCommand(
    "traje yerba a $50 y frutillas a $10",
    PRODUCTS,
    CUSTOMERS
  );
  assert.equal(r.kind, "match");
  if (r.kind === "match" && r.intent === "stock_load") {
    assert.equal(r.data.items.length, 2);
    // yerba (resolved to p1) and frutillas (not in catalog → null productId)
    assert.equal(r.data.items[0].productId, "p1");
    assert.equal(r.data.items[0].unitPrice, 50);
    assert.equal(r.data.items[1].productId, null);
    assert.equal(r.data.items[1].unitPrice, 10);
    // Quantity defaults to 1 when user omits it.
    assert.equal(r.data.items[0].quantity, 1);
    assert.equal(r.data.items[1].quantity, 1);
  }
});

test("compound: 'vendí 2 yerbas a juan. cargá 50 azúcares' → register_sale + stock_load", () => {
  const r = parseVeloraCommand(
    "vendí 2 yerbas a juan. cargá 50 azúcares",
    PRODUCTS,
    CUSTOMERS
  );
  assert.equal(r.kind, "compound");
  if (r.kind === "compound") {
    assert.equal(r.commands.length, 2);
    assert.equal(r.commands[0].kind === "match" && r.commands[0].intent, "register_sale");
    assert.equal(r.commands[1].kind === "match" && r.commands[1].intent, "stock_load");
  }
});

// ── inventory_list: bare and prefixed forms ─────────────────────────
// Before the priority fix these either fell through to the AI or were
// miscaught by check_stock. Bare "stock" / "dame el stock" / "decime el
// stock" must all resolve to inventory_list locally.

test("'dame el stock' → inventory_list", () => {
  const r = parseVeloraCommand("dame el stock", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "inventory_list");
});

test("'decime el stock' → inventory_list", () => {
  const r = parseVeloraCommand("decime el stock", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "inventory_list");
});

test("'dame el stock' (no product after keyword) → inventory_list", () => {
  const r = parseVeloraCommand("dame el stock", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "inventory_list");
});

test("bare 'stock' alone → inventory_list", () => {
  const r = parseVeloraCommand("stock", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "inventory_list");
});

test("bare 'inventario' alone → inventory_list", () => {
  const r = parseVeloraCommand("inventario", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "inventory_list");
});

test("'stock de yerba mate' still routes to check_stock (product name present)", () => {
  const r = parseVeloraCommand("stock de yerba mate", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") {
    assert.equal(r.intent, "check_stock");
    if (r.intent === "check_stock") assert.equal(r.data.productId, "p1");
  }
});

// ── STT split-word repair ───────────────────────────────────────────
// Browser SpeechRecognition can split "stock" into "stoc\nk" when the
// speaker pauses mid-word. collapse-split-keywords glues them back
// before dispatch. Without the repair these fall through to the AI.

test("'stoc\\nk' (mic split) → inventory_list", () => {
  const r = parseVeloraCommand("stoc\nk", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "inventory_list");
});

test("'stoc k' (mic split, space) → inventory_list", () => {
  const r = parseVeloraCommand("stoc k", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "inventory_list");
});

test("'inven tario' (mic split) → inventory_list", () => {
  const r = parseVeloraCommand("inven tario", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "inventory_list");
});

test("'dame el stoc\\nk' → inventory_list (prefix + split word)", () => {
  const r = parseVeloraCommand("dame el stoc\nk", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "inventory_list");
});

// ── cash_balance ────────────────────────────────────────────────────
// Bare nouns + verb phrasings both route to cash_balance. The parser
// used to miss "saldo" alone and "cuánto tenemos"; both added alongside
// the Command Layer wiring.

test("bare 'caja' → cash_balance", () => {
  const r = parseVeloraCommand("caja", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

test("bare 'saldo' → cash_balance", () => {
  const r = parseVeloraCommand("saldo", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

test("'saldo de caja' → cash_balance", () => {
  const r = parseVeloraCommand("saldo de caja", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

test("'cuánto hay en caja' → cash_balance", () => {
  const r = parseVeloraCommand("cuánto hay en caja", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

test("'cuánto tenemos' → cash_balance (new pattern)", () => {
  const r = parseVeloraCommand("cuánto tenemos", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

test("'cuánta plata tenemos' → cash_balance (Argentine slang)", () => {
  const r = parseVeloraCommand("cuánta plata tenemos", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

test("'cómo anda la caja' → cash_balance", () => {
  const r = parseVeloraCommand("cómo anda la caja", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "match");
  if (r.kind === "match") assert.equal(r.intent, "cash_balance");
});

// ── sales_summary ──────────────────────────────────────────────────
// Verb + period-aware matching. Default period = today when nothing
// else is mentioned; explicit "ayer" / "esta semana" / "este mes"
// overrides.

test("'cuánto vendí' → sales_summary today (default)", () => {
  const r = parseVeloraCommand("cuánto vendí", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "sales_summary") {
    assert.equal(r.data.period, "today");
  } else {
    assert.fail("expected sales_summary/today");
  }
});

test("'ventas de hoy' → sales_summary today", () => {
  const r = parseVeloraCommand("ventas de hoy", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "sales_summary") {
    assert.equal(r.data.period, "today");
  } else {
    assert.fail("expected sales_summary/today");
  }
});

test("'cuánto vendí ayer' → sales_summary yesterday", () => {
  const r = parseVeloraCommand("cuánto vendí ayer", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "sales_summary") {
    assert.equal(r.data.period, "yesterday");
  } else {
    assert.fail("expected sales_summary/yesterday");
  }
});

test("'resumen de ventas de esta semana' → sales_summary week", () => {
  const r = parseVeloraCommand("resumen de ventas de esta semana", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "sales_summary") {
    assert.equal(r.data.period, "week");
  } else {
    assert.fail("expected sales_summary/week");
  }
});

test("'ventas de este mes' → sales_summary month", () => {
  const r = parseVeloraCommand("ventas de este mes", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "sales_summary") {
    assert.equal(r.data.period, "month");
  } else {
    assert.fail("expected sales_summary/month");
  }
});

test("'cómo venimos' → sales_summary today (new pattern)", () => {
  const r = parseVeloraCommand("cómo venimos", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "sales_summary") {
    assert.equal(r.data.period, "today");
  } else {
    assert.fail("expected sales_summary for 'cómo venimos'");
  }
});

test("'cómo vamos este mes' → sales_summary month", () => {
  const r = parseVeloraCommand("cómo vamos este mes", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "sales_summary") {
    assert.equal(r.data.period, "month");
  } else {
    assert.fail("expected sales_summary/month for 'cómo vamos este mes'");
  }
});

test("'total de ventas' → sales_summary today", () => {
  const r = parseVeloraCommand("total de ventas", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "sales_summary") {
    assert.equal(r.data.period, "today");
  } else {
    assert.fail("expected sales_summary/today for 'total de ventas'");
  }
});

// ── find_customer ──────────────────────────────────────────────────
// Parser matches: "buscar cliente X" / "datos de X" / "teléfono de X"
// / "quién es X". Catalog search is accent/case-insensitive against
// name, plus digit-contains against phone. Tested as pure functions.

const {
  detectFindCustomer,
  findCustomerInCatalog,
  buildFindCustomerReply,
  buildFindCustomerNotFoundReply,
} = require("../../src/app/dashboard/lib/command-parsers/find-customer.ts");

test("'buscar cliente juan' → find_customer with query 'juan'", () => {
  const r = parseVeloraCommand("buscar cliente juan", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "find_customer") {
    assert.equal(r.data.query, "juan");
  } else {
    assert.fail("expected find_customer");
  }
});

test("'datos de maria' → find_customer with query 'maria'", () => {
  const r = parseVeloraCommand("datos de maria", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "find_customer") {
    assert.equal(r.data.query, "maria");
  } else {
    assert.fail("expected find_customer");
  }
});

test("'teléfono de carlos' → find_customer", () => {
  const r = parseVeloraCommand("teléfono de carlos", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "find_customer") {
    assert.equal(r.data.query, "carlos");
  } else {
    assert.fail("expected find_customer");
  }
});

test("'quién es Juan' → find_customer", () => {
  const r = parseVeloraCommand("quién es Juan", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "find_customer") {
    assert.equal(r.data.query, "juan");
  } else {
    assert.fail("expected find_customer");
  }
});

test("'dame los datos del cliente juan' → find_customer", () => {
  const r = parseVeloraCommand("dame los datos del cliente juan", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "find_customer") {
    assert.ok(/juan/i.test(r.data.query), `got query: ${r.data.query}`);
  } else {
    assert.fail("expected find_customer");
  }
});

test("detectFindCustomer: bare single word does NOT match (avoid false positives)", () => {
  // "juan" alone without a verb shouldn't trigger find_customer —
  // it has no context distinguishing it from a sale.
  const r = detectFindCustomer("juan");
  assert.equal(r, null);
});

// ── find_customer catalog search ────────────────────────────────────

const FIND_CLIENTS = [
  { id: "c1", name: "Carlos Rossi", phone: "1134567890", email: "carlos@example.com" },
  { id: "c2", name: "Juan Pérez", phone: null, email: null },
  { id: "c3", name: "María López", phone: "1199887766", email: "maria@x.com" },
];

test("findCustomerInCatalog: exact match by name", () => {
  const match = findCustomerInCatalog(FIND_CLIENTS, "Carlos Rossi");
  assert.ok(match);
  assert.equal(match.id, "c1");
});

test("findCustomerInCatalog: accent-insensitive match", () => {
  const match = findCustomerInCatalog(FIND_CLIENTS, "maria");
  assert.ok(match);
  assert.equal(match.id, "c3");
});

test("findCustomerInCatalog: substring match", () => {
  const match = findCustomerInCatalog(FIND_CLIENTS, "perez");
  assert.ok(match);
  assert.equal(match.id, "c2");
});

test("findCustomerInCatalog: phone digit match", () => {
  const match = findCustomerInCatalog(FIND_CLIENTS, "7890");
  assert.ok(match);
  assert.equal(match.id, "c1");
});

test("findCustomerInCatalog: not found returns null", () => {
  const match = findCustomerInCatalog(FIND_CLIENTS, "pedro");
  assert.equal(match, null);
});

test("buildFindCustomerReply: all fields present", () => {
  const reply = buildFindCustomerReply(FIND_CLIENTS[0]);
  assert.equal(
    reply,
    "Cliente: Carlos Rossi — Tel: 1134567890 — Email: carlos@example.com."
  );
});

test("buildFindCustomerReply: omits null phone and email", () => {
  const reply = buildFindCustomerReply(FIND_CLIENTS[1]);
  assert.equal(reply, "Cliente: Juan Pérez.");
});

test("buildFindCustomerNotFoundReply: fixed Spanish message", () => {
  assert.equal(
    buildFindCustomerNotFoundReply(),
    "No encontré ningún cliente con ese nombre."
  );
});

// ── low_stock_query ────────────────────────────────────────────────
// Parser matches a small set of natural Argentine phrasings. The
// filter + reply builder are pure (no Date.now or ctx dependencies)
// so they can be exercised directly.

const {
  findLowStockProducts,
  buildLowStockReply,
  DEFAULT_LOW_STOCK_THRESHOLD,
} = require("../../src/app/dashboard/lib/command-parsers/low-stock.ts");

test("'productos bajos' → low_stock_query", () => {
  const r = parseVeloraCommand("productos bajos", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") assert.equal(r.intent, "low_stock_query");
  else assert.fail("expected low_stock_query");
});

test("'poco stock' → low_stock_query", () => {
  const r = parseVeloraCommand("poco stock", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") assert.equal(r.intent, "low_stock_query");
  else assert.fail("expected low_stock_query");
});

test("'stock bajo' → low_stock_query", () => {
  const r = parseVeloraCommand("stock bajo", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") assert.equal(r.intent, "low_stock_query");
  else assert.fail("expected low_stock_query");
});

test("'qué productos tengo bajos' → low_stock_query", () => {
  const r = parseVeloraCommand("qué productos tengo bajos", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") assert.equal(r.intent, "low_stock_query");
  else assert.fail("expected low_stock_query");
});

test("'qué me está por faltar' → low_stock_query", () => {
  const r = parseVeloraCommand("qué me está por faltar", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") assert.equal(r.intent, "low_stock_query");
  else assert.fail("expected low_stock_query");
});

test("'qué me falta' → low_stock_query", () => {
  const r = parseVeloraCommand("qué me falta", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") assert.equal(r.intent, "low_stock_query");
  else assert.fail("expected low_stock_query");
});

test("'dame los productos bajos' → low_stock_query (request prefix)", () => {
  const r = parseVeloraCommand("dame los productos bajos", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") assert.equal(r.intent, "low_stock_query");
  else assert.fail("expected low_stock_query");
});

// ── low_stock_query filtering + reply ──────────────────────────────

const LOW_STOCK_CATALOG = [
  { id: "p1", name: "Yerba Mate 1kg", sku: "YERBA-1KG", price: 6200, stock: 20 },
  { id: "p2", name: "Azúcar 1kg", sku: "AZ-1KG", price: 1800, stock: 2 },
  { id: "p3", name: "Clavo 2 pulgadas", sku: null, price: 150, stock: 0 },
  { id: "p4", name: "Filtro Bosch", sku: "FB-01", price: 8000, stock: 4 },
];

test("findLowStockProducts: returns only stock < default threshold, sorted ascending", () => {
  const low = findLowStockProducts(LOW_STOCK_CATALOG);
  assert.equal(low.length, 3);
  assert.equal(low[0].id, "p3"); // stock 0
  assert.equal(low[1].id, "p2"); // stock 2
  assert.equal(low[2].id, "p4"); // stock 4
});

test("findLowStockProducts: custom threshold narrows the set", () => {
  const low = findLowStockProducts(LOW_STOCK_CATALOG, 3);
  assert.equal(low.length, 2);
  assert.deepEqual(
    low.map((p) => p.id),
    ["p3", "p2"]
  );
});

test("DEFAULT_LOW_STOCK_THRESHOLD equals 5 (matches server fallback)", () => {
  assert.equal(DEFAULT_LOW_STOCK_THRESHOLD, 5);
});

test("buildLowStockReply: empty list → 'no hay productos con poco stock'", () => {
  assert.equal(buildLowStockReply([]), "No hay productos con poco stock.");
});

test("buildLowStockReply: lists items with count header and correct unit plural", () => {
  const low = findLowStockProducts(LOW_STOCK_CATALOG);
  const reply = buildLowStockReply(low);
  assert.ok(reply.startsWith("Productos con poco stock (3):\n"));
  assert.ok(reply.includes("• Clavo 2 pulgadas — 0 unidades"));
  assert.ok(reply.includes("• Azúcar 1kg — 2 unidades"));
  assert.ok(reply.includes("• Filtro Bosch — 4 unidades"));
});

test("buildLowStockReply: uses 'unidad' (singular) when stock === 1", () => {
  const reply = buildLowStockReply([
    { id: "p9", name: "Test", sku: null, price: 100, stock: 1 },
  ]);
  assert.ok(reply.includes("— 1 unidad"));
  assert.ok(!reply.includes("1 unidades"));
});

// ── register_sale: autoSendWhatsapp unified field ──────────────────
// The parser now emits autoSendWhatsapp at parse time so callers
// don't need to re-scan the raw text with containsSendKeyword.

test("register_sale: no send keyword → autoSendWhatsapp=false", () => {
  const r = parseVeloraCommand("vendí 2 yerba mate a carlos", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.autoSendWhatsapp, false);
  } else {
    assert.fail("expected register_sale");
  }
});

test("register_sale: 'mandale' triggers autoSendWhatsapp=true", () => {
  const r = parseVeloraCommand("vendí 2 yerba mate a carlos y mandale por whatsapp", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.autoSendWhatsapp, true);
  } else {
    assert.fail("expected register_sale");
  }
});

test("register_sale: 'enviale' triggers autoSendWhatsapp=true", () => {
  const r = parseVeloraCommand("vendí 3 yerba mate a juan, enviale la factura", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.autoSendWhatsapp, true);
  } else {
    assert.fail("expected register_sale");
  }
});

test("register_sale: bare 'whatsapp' keyword triggers autoSendWhatsapp=true", () => {
  const r = parseVeloraCommand("vendí 1 yerba mate a carlos y whatsapp", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "register_sale") {
    assert.equal(r.data.autoSendWhatsapp, true);
  } else {
    assert.fail("expected register_sale");
  }
});

// ── product_price_query ────────────────────────────────────────────

const {
  buildProductPriceNotFoundReply,
  buildProductPriceReply,
} = require("../../src/app/dashboard/lib/command-parsers/product-price-query.ts");

test("'cuánto vale la yerba' → product_price_query with productId resolved", () => {
  const r = parseVeloraCommand("cuánto vale la yerba", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "product_price_query") {
    assert.equal(r.data.productId, "p1");
    assert.equal(r.data.productName, "yerba");
  } else {
    assert.fail("expected product_price_query");
  }
});

test("'¿cuánto cuesta el azúcar?' → product_price_query", () => {
  const r = parseVeloraCommand("¿cuánto cuesta el azúcar?", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "product_price_query") {
    assert.equal(r.data.productId, "p2");
  } else {
    assert.fail("expected product_price_query");
  }
});

test("'cuánto sale el clavo' → product_price_query", () => {
  const r = parseVeloraCommand("cuánto sale el clavo", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "product_price_query") {
    assert.equal(r.data.productId, "p3");
  } else {
    assert.fail("expected product_price_query");
  }
});

test("'precio de la yerba' → product_price_query", () => {
  const r = parseVeloraCommand("precio de la yerba", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "product_price_query") {
    assert.equal(r.data.productId, "p1");
  } else {
    assert.fail("expected product_price_query");
  }
});

test("'cuál es el precio de la yerba' → product_price_query", () => {
  const r = parseVeloraCommand("cuál es el precio de la yerba", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "product_price_query") {
    assert.equal(r.data.productId, "p1");
  } else {
    assert.fail("expected product_price_query");
  }
});

test("'qué precio tiene la yerba' → product_price_query", () => {
  const r = parseVeloraCommand("qué precio tiene la yerba", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "product_price_query") {
    assert.equal(r.data.productId, "p1");
  } else {
    assert.fail("expected product_price_query");
  }
});

test("'a qué precio está la yerba' → product_price_query", () => {
  const r = parseVeloraCommand("a qué precio está la yerba", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "product_price_query") {
    assert.equal(r.data.productId, "p1");
  } else {
    assert.fail("expected product_price_query");
  }
});

test("'decime el precio de la yerba' → product_price_query (via request prefix)", () => {
  const r = parseVeloraCommand("decime el precio de la yerba", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "product_price_query") {
    assert.equal(r.data.productId, "p1");
  } else {
    assert.fail("expected product_price_query");
  }
});

test("'valor de la yerba' → product_price_query", () => {
  const r = parseVeloraCommand("valor de la yerba", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "product_price_query") {
    assert.equal(r.data.productId, "p1");
  } else {
    assert.fail("expected product_price_query");
  }
});

test("'cuánto vale el aceite' → product_price_query with productId=null (not in catalog)", () => {
  const r = parseVeloraCommand("cuánto vale el aceite", PRODUCTS, CUSTOMERS);
  if (r.kind === "match" && r.intent === "product_price_query") {
    assert.equal(r.data.productId, null);
    assert.equal(r.data.productName, "aceite");
  } else {
    assert.fail("expected product_price_query");
  }
});

test("'cuántas yerbas tengo' → check_stock (not price_query — no price verb)", () => {
  const r = parseVeloraCommand("cuántas yerbas tengo", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") {
    assert.equal(r.intent, "check_stock");
  } else {
    assert.fail("expected check_stock");
  }
});

test("'el precio de la yerba es 6500' → edit_product (write intent wins over read)", () => {
  const r = parseVeloraCommand("el precio de la yerba es 6500", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") {
    assert.equal(r.intent, "edit_product");
  } else {
    assert.fail("expected edit_product");
  }
});

// ── product_price_query reply builders ─────────────────────────────

test("buildProductPriceReply: formats price with es-AR currency", () => {
  const reply = buildProductPriceReply("Yerba Mate 1kg", 6200, "ARS");
  assert.ok(reply.startsWith("Yerba Mate 1kg vale "));
  assert.ok(reply.endsWith("."));
  assert.ok(reply.includes("6") && reply.includes("200"));
});

test("buildProductPriceReply: falls back to ARS when currency empty", () => {
  const reply = buildProductPriceReply("Test", 100, "");
  assert.ok(reply.includes("Test vale"));
});

test("buildProductPriceNotFoundReply: returns catalog-miss sentence with the query echoed", () => {
  const reply = buildProductPriceNotFoundReply("aceite girasol");
  assert.ok(reply.includes('"aceite girasol"'));
  assert.ok(reply.includes("catálogo"));
});

// ── price_intent_fallback ─────────────────────────────────────────

const {
  buildPriceIntentFallbackReply,
} = require("../../src/app/dashboard/lib/command-parsers/price-intent-fallback.ts");

test("'el precio de lapapas 50, laperas 40' → price_intent_fallback (products unresolved)", () => {
  const r = parseVeloraCommand("el precio de lapapas 50, laperas 40", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") {
    assert.equal(r.intent, "price_intent_fallback");
  } else {
    assert.fail("expected price_intent_fallback");
  }
});

test("'precio xx 100, yy 200, zz 300' → price_intent_fallback (multiple unknowns)", () => {
  const r = parseVeloraCommand("precio xx 100, yy 200, zz 300", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") {
    assert.equal(r.intent, "price_intent_fallback");
  } else {
    assert.fail("expected price_intent_fallback");
  }
});

test("'el precio de la yerba es 6500' → edit_product wins (product resolved, single price)", () => {
  const r = parseVeloraCommand("el precio de la yerba es 6500", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") assert.equal(r.intent, "edit_product");
  else assert.fail("expected edit_product");
});

test("'subí todos los precios 10%' → bulk_price_update wins (bulk token rejects fallback)", () => {
  const r = parseVeloraCommand("subí todos los precios 10%", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") assert.equal(r.intent, "bulk_price_update");
  else assert.fail("expected bulk_price_update");
});

test("'cargar 50 xx a 100, 60 yy a 200' → stock_load wins over fallback (stock verb)", () => {
  const r = parseVeloraCommand("cargar 50 xx a 100, 60 yy a 200", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") assert.equal(r.intent, "stock_load");
  else assert.fail("expected stock_load");
});

test("'precio xx 100' → NOT fallback (only 1 price number)", () => {
  const r = parseVeloraCommand("precio xx 100", PRODUCTS, CUSTOMERS);
  if (r.kind === "match") {
    assert.notEqual(r.intent, "price_intent_fallback");
  }
});

test("'hola' → no match (fallback requires precio keyword)", () => {
  const r = parseVeloraCommand("hola", PRODUCTS, CUSTOMERS);
  assert.equal(r.kind, "no-match");
});

test("buildPriceIntentFallbackReply: mentions catalog names and shows example", () => {
  const reply = buildPriceIntentFallbackReply();
  assert.ok(reply.includes("catálogo"));
  assert.ok(reply.includes("papas"));
  assert.ok(reply.includes("peras"));
});
