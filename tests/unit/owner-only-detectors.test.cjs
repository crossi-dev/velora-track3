/**
 * owner-only-detectors.test.cjs
 *
 * Valida que detectOwnerOnlyIntent reconozca todas las frases del smoke
 * matrix RBAC (scripts/smoke-matrix.mjs) para que el dispatcher emita
 * warm reject canónico SIN llamar al LLM (que alucinaba "Producto borrado").
 */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { detectOwnerOnlyIntent } = require(
  "../../src/app/api/business-assistant/_lib/handlers/owner-only-detectors.ts",
);

const CATALOG = {
  products: [
    { name: "tuercas" },
    { name: "destornilladores" },
    { name: "Sierra circular" },
  ],
  customers: [
    { name: "Carlos Rossi" },
    { name: "Felix Lopez" },
  ],
};

function expect(text, expected) {
  const got = detectOwnerOnlyIntent(text, CATALOG);
  assert.equal(got, expected, `"${text}" → expected=${expected} got=${got}`);
}

// ─── delete_product ─────────────────────────────────────────────────────────
test("delete_product: 'borrá el destornillador del catálogo'", () =>
  expect("borrá el destornillador del catálogo", "delete_product"));
test("delete_product: 'eliminá la tuerca'", () =>
  expect("eliminá la tuerca", "delete_product"));

// ─── bulk_price_update ──────────────────────────────────────────────────────
test("bulk_price_update: 'subí todos los precios un 10%'", () =>
  expect("subí todos los precios un 10%", "bulk_price_update"));
test("bulk_price_update: 'aumentá un 15 por ciento todo el catálogo'", () =>
  expect("aumentá un 15 por ciento todo el catálogo", "bulk_price_update"));

// ─── adjust_stock ───────────────────────────────────────────────────────────
test("adjust_stock: 'ponele 30 unidades de stock al destornillador'", () =>
  expect("ponele 30 unidades de stock al destornillador", "adjust_stock"));
test("adjust_stock: 'ajustá el stock de tuercas a 50'", () =>
  expect("ajustá el stock de tuercas a 50", "adjust_stock"));

// ─── register_movement ─────────────────────────────────────────────────────
test("register_movement: 'registra un gasto de 5000 pesos por luz'", () =>
  expect("registra un gasto de 5000 pesos por luz", "register_movement"));
test("register_movement: 'anotá un ingreso a caja de 10000'", () =>
  expect("anotá un ingreso a caja de 10000", "register_movement"));

// ─── edit_customer ─────────────────────────────────────────────────────────
test("edit_customer: 'cambiale el teléfono a Carlos Rossi a 1198765432'", () =>
  expect("cambiale el teléfono a Carlos Rossi a 1198765432", "edit_customer"));
test("edit_customer: 'actualizá el mail de Felix'", () =>
  expect("actualizá el mail de Felix", "edit_customer"));

// ─── create_product ────────────────────────────────────────────────────────
test("create_product: 'agregá un producto nuevo: martillo a 8000'", () =>
  expect("agregá un producto nuevo: martillo a 8000", "create_product"));
test("create_product: 'cargá serrucho con precio 15000'", () =>
  expect("cargá serrucho con precio 15000", "create_product"));

// ─── create_supplier ───────────────────────────────────────────────────────
test("create_supplier: 'agregá proveedor Distribuidora Sur'", () =>
  expect("agregá proveedor Distribuidora Sur", "create_supplier"));
test("create_supplier: 'nuevo proveedor: Ferretera Norte'", () =>
  expect("nuevo proveedor: Ferretera Norte", "create_supplier"));

// ─── edit_supplier ────────────────────────────────────────────────────────
test("edit_supplier: 'cambiale el teléfono a Distribuidora Sur' (any owner-only ok)", () => {
  // Sin la palabra "proveedor" no se puede distinguir supplier de customer
  // sólo por el texto — el smoke matrix sólo verifica que se warm-reject;
  // tanto edit_supplier como edit_customer producen "los maneja el dueño".
  const got = detectOwnerOnlyIntent("cambiale el teléfono a Distribuidora Sur", CATALOG);
  assert.ok(
    got === "edit_supplier" || got === "edit_customer",
    `expected edit_supplier or edit_customer, got ${got}`,
  );
});
test("edit_supplier: 'actualizá el mail del proveedor ABC'", () =>
  expect("actualizá el mail del proveedor ABC", "edit_supplier"));

// ─── create_budget ─────────────────────────────────────────────────────────
test("create_budget: 'armá un presupuesto para Carlos con 3 tuercas'", () =>
  expect("armá un presupuesto para Carlos con 3 tuercas", "create_budget"));
test("create_budget: 'generá un presupuesto al cliente Juan'", () =>
  expect("generá un presupuesto al cliente Juan", "create_budget"));

// ─── create_purchase_request ───────────────────────────────────────────────
test("create_purchase_request: 'pedile a Distribuidora Sur 50 tuercas'", () =>
  expect("pedile a Distribuidora Sur 50 tuercas", "create_purchase_request"));
test("create_purchase_request: 'armá una orden de compra de 100 destornilladores'", () =>
  expect("armá una orden de compra de 100 destornilladores", "create_purchase_request"));

// ─── No false positives ────────────────────────────────────────────────────
test("no FP: 'cuántas tuercas tengo'", () =>
  expect("cuántas tuercas tengo", null));
test("no FP: 'vendele una tuerca a felix'", () =>
  expect("vendele una tuerca a felix", null));
test("no FP: 'cómo va el día'", () =>
  expect("cómo va el día", null));
test("no FP: empty", () => expect("", null));
