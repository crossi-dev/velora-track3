// Tests for NLU Fast Path fixes — sprint pre-demo 2026-05-15
// Covers FIX 1-6 regressions and new behaviours.

const assert = require("node:assert/strict");
const test = require("node:test");

const { detectStockSummaryFastPath, detectStockQueryFastPath } =
  require("../../src/app/api/business-assistant/_lib/nlu/stock-query-fast-path.ts");

const { detectPriceQueryFastPath } =
  require("../../src/app/api/business-assistant/_lib/nlu/price-query-fast-path.ts");

const { detectStockLoadFastPath } =
  require("../../src/app/api/business-assistant/_lib/nlu/stock-load-fast-path.ts");

const { normalizeArMoneySlang } =
  require("../../src/app/api/business-assistant/_lib/shared.ts");

const { detectDeleteProductFastPath } =
  require("../../src/app/api/business-assistant/_lib/nlu/delete-product-fast-path.ts");

const { looksLikeCobroQrIntent } =
  require("../../src/app/api/business-assistant/_lib/handlers/cobro-qr-intent.ts");

const { detectSaleCreateFastPath } =
  require("../../src/app/api/business-assistant/_lib/nlu/sale-create-fast-path.ts");

// ─── FIX 1: "fernet stock" → stock query específico, NO summary ──────────────

test("FIX1: 'fernet stock' debe ser stock query específico (no summary)", () => {
  assert.equal(detectStockSummaryFastPath("fernet stock"), false,
    "detectStockSummaryFastPath: fernet stock debe ser falso");
  const q = detectStockQueryFastPath("fernet stock");
  assert.ok(q !== null, "detectStockQueryFastPath: debe detectar un producto");
  assert.ok(q.productText.includes("fernet"), `productText debe contener 'fernet', got: ${q?.productText}`);
});

test("FIX1: 'birras stock' → stock query específico", () => {
  assert.equal(detectStockSummaryFastPath("birras stock"), false);
  const q = detectStockQueryFastPath("birras stock");
  assert.ok(q !== null);
  assert.ok(q.productText.includes("birras") || q.productText.includes("birra"), `got: ${q?.productText}`);
});

test("FIX1: 'stock' solo → stock summary (sin nombre de producto)", () => {
  assert.equal(detectStockSummaryFastPath("stock"), true,
    "stock solo debe seguir siendo summary");
});

test("FIX1: 'el stock' → stock summary", () => {
  assert.equal(detectStockSummaryFastPath("el stock"), true);
});

test("FIX1: 'cuánto stock tengo' → stock summary", () => {
  assert.equal(detectStockSummaryFastPath("cuánto stock tengo"), true);
});

// ─── FIX 2: "cuánto está X" matchea precio ───────────────────────────────────

test("FIX2: 'cuánto está el fernet' → price query", () => {
  const r = detectPriceQueryFastPath("cuánto está el fernet");
  assert.ok(r !== null, "debe detectar precio");
  assert.equal(r.queryKind, "price");
  assert.ok(r.productText.includes("fernet"), `productText: ${r?.productText}`);
});

test("FIX2: 'a cuánto está la coca' → price query", () => {
  const r = detectPriceQueryFastPath("a cuánto está la coca");
  assert.ok(r !== null);
  assert.equal(r.queryKind, "price");
  assert.ok(r.productText.includes("coca"), `productText: ${r?.productText}`);
});

test("FIX2: 'cuánto vale la coca' → price query (existente, no regresión)", () => {
  const r = detectPriceQueryFastPath("cuánto vale la coca");
  assert.ok(r !== null);
  assert.equal(r.queryKind, "price");
});

// ─── FIX 3: "compré 50 birras" → stock load ──────────────────────────────────

test("FIX3: 'compré 50 birras' → stock load", () => {
  const r = detectStockLoadFastPath("compré 50 birras");
  assert.ok(r !== null, "debe detectar stock load");
  assert.equal(r.quantity, 50);
  assert.ok(r.productHint.includes("birras") || r.productHint.includes("birra"), `productHint: ${r?.productHint}`);
});

test("FIX3: 'compré 30 fernetitos a 500' → stock load con precio", () => {
  const r = detectStockLoadFastPath("compré 30 fernetitos a 500");
  assert.ok(r !== null);
  assert.equal(r.quantity, 30);
  assert.equal(r.unitCost, 500);
});

test("FIX3: 'compramos 20 cajas de agua' → stock load", () => {
  const r = detectStockLoadFastPath("compramos 20 cajas de agua");
  assert.ok(r !== null);
  assert.equal(r.quantity, 20);
});

test("FIX3: 'llegaron 12 cocas' → stock load (no regresión)", () => {
  const r = detectStockLoadFastPath("llegaron 12 cocas");
  assert.ok(r !== null);
  assert.equal(r.quantity, 12);
});

// ─── FIX 4: normalizeArMoneySlang ────────────────────────────────────────────

test("FIX4: '5 lucas' → '5000'", () => {
  assert.equal(normalizeArMoneySlang("cobro 5 lucas"), "cobro 5000");
});

test("FIX4: '2 lukas' (typo) → '2000'", () => {
  assert.equal(normalizeArMoneySlang("cobro 2 lukas"), "cobro 2000");
});

test("FIX4: '3 gambas' → '300'", () => {
  assert.equal(normalizeArMoneySlang("cobro 3 gambas"), "cobro 300");
});

test("FIX4: '10 mangos' → '10'", () => {
  assert.equal(normalizeArMoneySlang("cobro 10 mangos"), "cobro 10");
});

test("FIX4: '1 palo' → '1000000'", () => {
  assert.equal(normalizeArMoneySlang("cobro 1 palo"), "cobro 1000000");
});

test("FIX4: '2 palos' → '2000000'", () => {
  assert.equal(normalizeArMoneySlang("cobro 2 palos"), "cobro 2000000");
});

test("FIX4: texto sin slang no se modifica", () => {
  assert.equal(normalizeArMoneySlang("cobro 5000"), "cobro 5000");
});

// FIX4b: cobro variantes verbales
const EMPTY_CUSTOMERS = [];

test("FIX4b: 'cobré 5000 qr' → cobro_qr", () => {
  const r = looksLikeCobroQrIntent("cobré 5000 qr", EMPTY_CUSTOMERS);
  assert.ok(r !== null, "cobré debe matchear cobro_qr");
  assert.equal(r.monto, 5000);
  assert.equal(r.metodo, "qr");
});

test("FIX4b: 'cobro 5000' → cobro_qr (no regresión)", () => {
  const r = looksLikeCobroQrIntent("cobro 5000", EMPTY_CUSTOMERS);
  assert.ok(r !== null);
  assert.equal(r.monto, 5000);
});

test("FIX4b: 'cobrale 5000 a Juan' NO matchea cobro_qr (es sale_send)", () => {
  const r = looksLikeCobroQrIntent("cobrale 5000 a Juan", EMPTY_CUSTOMERS);
  assert.equal(r, null, "cobrale pertenece a sale_send");
});

// ─── FIX 5: delete_product bare noun con catálogo ────────────────────────────

const CATALOG_FIX5 = [
  { id: "p1", name: "Fernet Branca" },
  { id: "p2", name: "Coca Cola" },
];

test("FIX5: 'borrá el fernet branca' (exacto en catálogo) → delete", () => {
  const r = detectDeleteProductFastPath("borrá el fernet branca", CATALOG_FIX5);
  assert.ok(r !== null, "debe detectar delete con nombre exacto");
  assert.ok(r.productText.includes("fernet"), `productText: ${r?.productText}`);
});

test("FIX5: 'borrá el producto fernet branca' (con noun) → delete (no regresión)", () => {
  const r = detectDeleteProductFastPath("borrá el producto fernet branca", CATALOG_FIX5);
  assert.ok(r !== null);
});

test("FIX5: 'borrá el carlos' (nombre que no está en catálogo) → null", () => {
  const r = detectDeleteProductFastPath("borrá el carlos", CATALOG_FIX5);
  assert.equal(r, null, "no debe matchear nombres que no están en catálogo");
});

test("FIX5: 'borrá' sin catálogo → null (conservador)", () => {
  const r = detectDeleteProductFastPath("borrá el fernet branca");
  assert.equal(r, null, "sin catálogo no debe matchear bare noun");
});

// ─── FIX 6: sale_create_pending_customer ────────────────────────────────────

const PRODUCTS_FIX6 = [
  { id: "p1", name: "Fernet Branca" },
  { id: "p2", name: "Coca Cola" },
];

const CUSTOMERS_FIX6 = [
  { id: "c1", name: "Juan Pérez" },
  { id: "c2", name: "María García" },
];

test("FIX6: 'vendí 2 fernet' sin cliente → pending_customer", () => {
  const r = detectSaleCreateFastPath("vendí 2 fernet", { products: PRODUCTS_FIX6, customers: CUSTOMERS_FIX6 });
  assert.ok(r !== null, "debe retornar resultado");
  assert.equal(r.kind, "pending_customer");
  assert.equal(r.matchedProductId, "p1");
  assert.equal(r.qty, 2);
});

test("FIX6: 'vendí coca a Juan' (cliente resuelto) → sale_create full", () => {
  const r = detectSaleCreateFastPath("vendí coca a Juan", { products: PRODUCTS_FIX6, customers: CUSTOMERS_FIX6 });
  assert.ok(r !== null);
  // SaleCreateFastPathMatch no tiene 'kind' property
  assert.ok(!("kind" in r) || r.kind === undefined, "no debe ser pending_customer");
  assert.equal(r.matchedProductId, "p2");
  assert.ok("matchedCustomerId" in r);
});

test("FIX6: 'vendí fernet' sin catálogo de clientes → null (cae al LLM)", () => {
  const r = detectSaleCreateFastPath("vendí fernet", { products: PRODUCTS_FIX6, customers: [] });
  assert.equal(r, null, "sin clientes no puede mostrar picker, debe caer al LLM");
});
