// Regression tests pinning every user-reported bug phrasing from this
// session to the detector behavior that fixes it. If any of these break,
// we've regressed on a real user complaint — grep the SHA in the header
// to find the fix commit and root cause.

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  isShortConfirmation,
  isShortCancellation,
} = require("../../src/app/dashboard/lib/hooks/confirmation-intent.ts");

const {
  detectMultiProductPriceEdit,
} = require("../../src/app/api/business-assistant/_lib/handlers/multi-price-detector.ts");

const {
  looksLikePriceUpdateIntent,
} = require("../../src/app/api/business-assistant/_lib/handlers/price-intent-detector.ts");

const {
  looksLikeSaleWithForgottenCustomer,
} = require("../../src/app/api/business-assistant/_lib/handlers/forgot-customer.ts");

const {
  matchProductByName,
} = require("../../src/app/api/business-assistant/_lib/match-product-by-name.ts");

const {
  getProductCandidates,
} = require("../../src/app/api/business-assistant/_lib/handlers/product-candidates.ts");

const FERRETERIA_CATALOG = [
  { id: "p1", name: "Papas" },
  { id: "p2", name: "Peras" },
  { id: "p3", name: "Sandías" },
  { id: "p4", name: "Clavo 2 pulgadas" },
  { id: "p5", name: "Arena Gruesa Premium" },
  { id: "p6", name: "Arena Fina" },
  { id: "p7", name: "Filtro Bosch" },
];

// ── #7 `e707d6b` — confirmation flow ─────────────────────────────────
// User complained: "typed 'dale' after confirmation card, nothing happened."

test("regression #7: 'dale' confirms pending action", () => {
  assert.equal(isShortConfirmation("dale"), true);
  assert.equal(isShortConfirmation("sí"), true);
  assert.equal(isShortConfirmation("ok"), true);
  assert.equal(isShortConfirmation("perfecto"), true);
});

test("regression #7: 'no' cancels pending action", () => {
  assert.equal(isShortCancellation("no"), true);
  assert.equal(isShortCancellation("cancelar"), true);
});

test("regression #7: compound message does NOT short-circuit", () => {
  assert.equal(isShortConfirmation("dale, vendele 3 papas"), false);
  assert.equal(isShortCancellation("no, mejor cargá 5 clavos"), false);
});

// ── #1 `57e83d7` — multi-price misroute ──────────────────────────────
// User complained: "el precio de las papas $50 ... preguntó porcentaje o monto"

test("regression #1: multi-price '$X, $Y' routes to edit_product", () => {
  const result = detectMultiProductPriceEdit(
    "el precio de las papas $50, el precio de las peras $40, el precio de las sandías $150",
    FERRETERIA_CATALOG.map((p) => p.name)
  );
  assert.equal(result?.length, 3);
  assert.equal(result?.[0].productName, "Papas");
});

test("regression #1: bulk phrasing still falls through to model", () => {
  assert.equal(
    detectMultiProductPriceEdit("subí todos los precios 10%", FERRETERIA_CATALOG.map((p) => p.name)),
    null
  );
});

// ── #2 `5c5e194` — STT-mangled retry ─────────────────────────────────
// User complained: "al precio de las papas $50 el precio de la espera es $40
// de personas Al Día 150" classified as stock_load.

test("regression #2: STT-mangled price triggers clarification", () => {
  // Catalog-aware detector FAILS (espera/dia aren't products)
  const catalogResult = detectMultiProductPriceEdit(
    "al precio de las papas $50 el precio de la espera es $40 de personas Al Día 150",
    FERRETERIA_CATALOG.map((p) => p.name)
  );
  assert.equal(catalogResult, null);

  // But price-intent detector triggers → clarification returned
  assert.equal(
    looksLikePriceUpdateIntent(
      "al precio de las papas $50 el precio de la espera es $40 de personas Al Día 150"
    ),
    true
  );
});

// ── #5 `813d35a` — forgot customer ───────────────────────────────────
// User complaint: various "no sé quién" phrasings didn't trigger picker.

test("regression #5: 'vendí clavos no me acuerdo a quién' → picker", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí clavos no me acuerdo a quién"),
    true
  );
});

test("regression #5: Argentine slang 'ni idea' triggers picker", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí papas ni idea a quién"),
    true
  );
});

test("regression #5: 'a Juan' blocks picker (named customer)", () => {
  assert.equal(
    looksLikeSaleWithForgottenCustomer("vendí a Juan pero no recuerdo cuánto"),
    false
  );
});

// ── #8 `88eee19` — fuzzy product match ───────────────────────────────
// Silent data loss when model returns 'Arena' but catalog has 'Arena Gruesa
// Premium'.

test("regression #8: 'Arena' matches 'Arena Gruesa Premium'", () => {
  const m = matchProductByName("Arena", FERRETERIA_CATALOG);
  assert.ok(m);
  assert.equal(m?.id, "p5");
});

test("regression #8: 'Filtro Bosh' (typo) matches 'Filtro Bosch'", () => {
  const m = matchProductByName("Filtro Bosh", FERRETERIA_CATALOG);
  assert.equal(m?.id, "p7");
});

test("regression #8: short 'a' never matches", () => {
  assert.equal(matchProductByName("a", FERRETERIA_CATALOG), null);
});

// ── #6 `2651183` — product candidates on ambiguous ───────────────────

test("regression #6: ambiguous 'arena' returns both catalog arenas", () => {
  const candidates = getProductCandidates("arena", FERRETERIA_CATALOG);
  assert.equal(candidates.length, 2);
  const names = candidates.map((c) => c.name);
  assert.ok(names.includes("Arena Fina"));
  assert.ok(names.includes("Arena Gruesa Premium"));
});

test("regression #6: full-sentence query picks Filtro Bosch", () => {
  const candidates = getProductCandidates(
    "dame el precio del filtro bosch",
    FERRETERIA_CATALOG
  );
  assert.ok(candidates.some((c) => c.name === "Filtro Bosch"));
});

// ── Cross-fix integration ────────────────────────────────────────────
// Ensure fixes don't interfere with each other.

test("integration: 'dale, vendele 3 papas' doesn't trigger confirm OR forgot-customer", () => {
  assert.equal(isShortConfirmation("dale, vendele 3 papas"), false);
  // Named-customer absent but sale context present + "dale" (not a forgot phrase)
  assert.equal(
    looksLikeSaleWithForgottenCustomer("dale, vendele 3 papas"),
    false
  );
});

test("integration: multi-price + price-intent are mutually consistent", () => {
  const text = "el precio de las papas $50, las peras $40";
  const multiPrice = detectMultiProductPriceEdit(text, FERRETERIA_CATALOG.map((p) => p.name));
  const priceIntent = looksLikePriceUpdateIntent(text);
  // Both should fire; catalog-aware handler runs first so price-intent fallback never triggers,
  // but the invariant is: if catalog detector matches, price-intent also matches (same phrase).
  assert.ok(multiPrice);
  assert.equal(priceIntent, true);
});
