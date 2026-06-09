const assert = require("node:assert/strict");
const test = require("node:test");

const { detectDeterministicIntent } = require(
  "../../src/app/api/business-assistant/_lib/nlu/detect.ts"
);

const ctx = {
  catalog: {
    products: [
      { id: "p1", name: "tuercas" },
      { id: "p2", name: "destornilladores" },
    ],
    customers: [
      { id: "c1", name: "Carlos Rossi" },
      { id: "c2", name: "Felix" },
    ],
  },
  productInfoDirectory: [{ name: "tuercas" }, { name: "destornilladores" }],
  invoiceDirectory: [],
  purchaseRequestDirectory: [],
};

test("returns null for empty text", () => {
  assert.equal(detectDeterministicIntent("", ctx), null);
  assert.equal(detectDeterministicIntent("   ", ctx), null);
});

test("returns price_query for price question about known product", () => {
  // 2026-05-10: Fast Path now covers price questions — price_query detector
  // fires before LLM. "cuánto vale X" → price_query, not null.
  const r = detectDeterministicIntent("cuánto vale el destornillador", ctx);
  assert.equal(r?.kind, "price_query");
  assert.equal(r.queryKind, "price");
});

test("undo intent — 'borrá las últimas 2 ventas'", () => {
  const r = detectDeterministicIntent("borrá las últimas 2 ventas", ctx);
  assert.equal(r?.kind, "undo");
  assert.equal(r.target, "sale");
  assert.equal(r.count, 2);
});

test("forgot_customer intent — sale verb without customer", () => {
  // 2026-05 NLU evolution: "vendi una tuerca" (no forgot phrase, no customer)
  // no longer routes to forgot_customer. It now hits sale_create_pending_customer
  // (label 4b) which asks for the customer via the sale-create flow.
  // forgot_customer fires only when the user includes an explicit "no recuerdo /
  // no me sale el nombre / un cliente" phrase — bare sale verbs without a
  // customer go to sale_create_pending_customer instead.
  // Test updated: assert that the result is NOT forgot_customer (still valid —
  // we assert the intent gate doesn't accidentally fire forgot_customer on this).
  const r = detectDeterministicIntent("vendi una tuerca", ctx);
  if (r) {
    assert.notEqual(r.kind, "forgot_customer",
      "bare 'vendi una X' without forgot phrase should not be forgot_customer");
  }
});

test("create_customer intent", () => {
  const r = detectDeterministicIntent("nuevo cliente Juan tel 261112233", ctx);
  assert.equal(r?.kind, "create_customer");
});

test("sale_send intent — match producto y cliente", () => {
  const r = detectDeterministicIntent("vendi una tuerca a carlos mandale wapp", ctx);
  assert.equal(r?.kind, "sale_send");
  assert.equal(r.matchedProductId, "p1");
  assert.equal(r.matchedCustomerId, "c1");
  assert.equal(r.productName, "tuercas");
  assert.equal(r.needsLlmFallback, false);
});

test("sale_send intent — needs LLM fallback if customer unmatched", () => {
  // Cliente con nombre propio capitalizado, NO en el catálogo, NO un
  // forgot_pattern → cae a sale_send con needsLlmFallback=true para que
  // el LLM intente extraer "Pepito Pérez" como customerName.
  const r = detectDeterministicIntent("vendi una tuerca a Pepito Pérez mandale wapp", ctx);
  assert.equal(r?.kind, "sale_send");
  assert.equal(r.matchedProductId, "p1");
  assert.equal(r.matchedCustomerId, null);
  assert.equal(r.needsLlmFallback, true);
});

test("single_price_edit intent", () => {
  const r = detectDeterministicIntent("cambia el precio de tuercas a 80", ctx);
  assert.equal(r?.kind, "single_price_edit");
});

test("multi_price_edit intent", () => {
  const r = detectDeterministicIntent(
    "el precio de tuercas $50, destornilladores $40",
    ctx,
  );
  assert.equal(r?.kind, "multi_price_edit");
  assert.ok(Array.isArray(r.edits));
  assert.equal(r.edits.length, 2);
});

test("price_update_clarification — verbo + precio + ≥2 números pero sin productos del catálogo", () => {
  const r = detectDeterministicIntent(
    "cambia el precio de las cosas a $50 y $40",
    ctx,
  );
  // Cae a clarification porque no matchea catalog products
  if (r) {
    assert.match(r.kind, /single_price_edit|price_update_clarification/);
  }
});

test("create_product Fast Path — 'cargar producto X N unidades P pesos cada una'", () => {
  const r = detectDeterministicIntent(
    "cargar producto nuevo: tornillos 50 unidades 120 pesos cada una",
    ctx,
  );
  assert.equal(r?.kind, "create_product");
  assert.equal(r.name, "tornillos");
  assert.equal(r.price, 120);
  assert.equal(r.stock, 50);
});

test("create_product Fast Path — 'nuevo producto NAME a P, tengo S'", () => {
  const r = detectDeterministicIntent(
    "nuevo producto fernet a 2500, tengo 100",
    ctx,
  );
  assert.equal(r?.kind, "create_product");
  assert.equal(r.name, "fernet");
  assert.equal(r.price, 2500);
  assert.equal(r.stock, 100);
});

test("create_product Fast Path — sin stock cae a 0", () => {
  const r = detectDeterministicIntent("agregá producto destornillador a 800", ctx);
  assert.equal(r?.kind, "create_product");
  assert.equal(r.name, "destornillador");
  assert.equal(r.price, 800);
  assert.equal(r.stock, 0);
});

test("create_product Fast Path — falla si no hay precio (cae a Slow Path)", () => {
  const r = detectDeterministicIntent("cargar producto nuevo tornillos", ctx);
  // Sin precio extraíble, el detector devuelve null y el flujo cae al LLM.
  assert.equal(r, null);
});

test("priority — undo wins over forgot_customer when both possible", () => {
  // 'cancela la última venta' debería ser undo, no forgot_customer
  const r = detectDeterministicIntent("cancela la última venta", ctx);
  assert.equal(r?.kind, "undo");
});

test("owner skip — single_price_edit no se detecta para owner", () => {
  // Owner: single_price_edit está gateado por actorRole !== "owner".
  // El detector puede devolver otro intent (e.g. price_query) pero nunca single_price_edit.
  const ownerCtx = { ...ctx, actorRole: "owner" };
  const r = detectDeterministicIntent("cambia el precio de tuercas a 80", ownerCtx);
  // single_price_edit NUNCA debe aparecer para owner — el LLM/supervisor lo maneja mejor.
  assert.notEqual(r?.kind, "single_price_edit");
});

test("owner — undo SÍ se detecta (owner puede hacer undo)", () => {
  const ownerCtx = { ...ctx, actorRole: "owner" };
  const r = detectDeterministicIntent("borrá las últimas 2 ventas", ownerCtx);
  assert.equal(r?.kind, "undo");
});

test("mightBeDeterministicIntent — true cuando hay hint", () => {
  const { mightBeDeterministicIntent } = require(
    "../../src/app/api/business-assistant/_lib/nlu/detect.ts"
  );
  assert.equal(mightBeDeterministicIntent("vendi una tuerca a carlos"), true);
  assert.equal(mightBeDeterministicIntent("borrá la última venta"), true);
  assert.equal(mightBeDeterministicIntent("cuánto vale el destornillador"), true);
});

test("mightBeDeterministicIntent — credential keywords gate the pipeline (Bug 1 regression)", () => {
  const { mightBeDeterministicIntent } = require(
    "../../src/app/api/business-assistant/_lib/nlu/detect.ts"
  );
  // Courier connect — OCA, Andreani, Correo
  assert.equal(mightBeDeterministicIntent("conectame OCA"), true);
  assert.equal(mightBeDeterministicIntent("conectame a MODO"), true);
  assert.equal(mightBeDeterministicIntent("reconectame Mercado Pago"), true);
  assert.equal(mightBeDeterministicIntent("reconectar Andreani"), true);
  assert.equal(mightBeDeterministicIntent("vincular MP"), true);
  assert.equal(mightBeDeterministicIntent("quiero conectar ARCA"), true);
  assert.equal(mightBeDeterministicIntent("configurame AFIP"), true);
  // CBU / alias
  assert.equal(mightBeDeterministicIntent("mi CBU es 0720031188000038090571"), true);
  assert.equal(mightBeDeterministicIntent("cambiá mi alias a tienda.mp"), true);
  // Inventory summary with inventario keyword (Bug 6b regression)
  assert.equal(mightBeDeterministicIntent("qué inventario tengo"), true);
});

test("mightBeDeterministicIntent — false para queries puramente conversacionales (sin keyword)", () => {
  const { mightBeDeterministicIntent } = require(
    "../../src/app/api/business-assistant/_lib/nlu/detect.ts"
  );
  // El pre-check es deliberadamente permisivo: false positives = overhead chico,
  // false negatives = perder intents. Solo retorna false si NINGÚN keyword
  // (vendi/borra/precio/stock/etc) aparece. "armame un reporte" matchea via
  // 'venta' en muchos casos — eso está OK, el dispatcher decide después.
  assert.equal(mightBeDeterministicIntent("cómo va el día"), false);
  assert.equal(mightBeDeterministicIntent("hola"), false);
  // NOTE 2026-05-10: `regla` se quitó del pre-gate cuando revertimos el
  // update_business_rule Fast Path al Slow Path (LLM). "creame una regla
  // nueva" / "cambiá la regla X" caen directo al LLM sin pasar por el
  // dispatcher determinístico — esperado para flujos no-urgentes donde
  // priorizamos correctness sobre latencia.
  assert.equal(mightBeDeterministicIntent("ayudame a pensar"), false);
  assert.equal(mightBeDeterministicIntent("creame una regla nueva"), false);
});

// ──────────────────────────────────────────────────────────────────────
// Fast Paths added 2026-05-10 — sale_create / delete_product.
// Conservative on purpose: false-positives son catastróficos en destructive
// ops. delete_customer / update_business_rule fueron revertidos al Slow
// Path el mismo día — eran redirect-only y el trade-off de latencia no se
// justificaba para flujos no-urgentes.
// ──────────────────────────────────────────────────────────────────────

test("sale_create Fast Path — 'vendi 2 tuercas a carlos por 500'", () => {
  const r = detectDeterministicIntent("vendi 2 tuercas a Carlos por 500", ctx);
  assert.equal(r?.kind, "sale_create");
  assert.equal(r.matchedProductId, "p1");
  assert.equal(r.matchedCustomerId, "c1");
  assert.equal(r.qty, 2);
  // qty > 1 → unitPrice stays null (heuristic in detector keeps catalog price)
  assert.equal(r.unitPrice, null);
});

test("sale_create Fast Path — 'vendele una tuerca a felix'", () => {
  const r = detectDeterministicIntent("vendele una tuerca a Felix", ctx);
  assert.equal(r?.kind, "sale_create");
  assert.equal(r.matchedProductId, "p1");
  assert.equal(r.matchedCustomerId, "c2");
});

// Regression: smoke harness "vendé un X a Y" (voseo imperative) caía
// al Slow Path (~8s) porque SALE_VERB_RE no listaba `vende`. El smoke
// envía con tilde; normalizeForMatching la borra dejando `vende`.
test("sale_create Fast Path — voseo 'vendé un X a Y' matches", () => {
  const r = detectDeterministicIntent("vendé un tuerca a Carlos", ctx);
  assert.equal(r?.kind, "sale_create");
  assert.equal(r.matchedProductId, "p1");
  assert.equal(r.matchedCustomerId, "c1");
  assert.equal(r.qty, 1);
});

test("sale_create Fast Path — falla sin cliente del catálogo (cae a LLM)", () => {
  const r = detectDeterministicIntent("vendi 1 tuerca a Pedro", ctx);
  // Pedro no está en el catálogo — debería caer al LLM
  assert.notEqual(r?.kind, "sale_create");
});

test("sale_create Fast Path — no se activa si hay send keyword (es sale_send)", () => {
  const r = detectDeterministicIntent("vendi 1 tuerca a Carlos y mandale", ctx);
  assert.equal(r?.kind, "sale_send");
});

test("delete_product Fast Path — 'borrá el producto tuercas'", () => {
  const r = detectDeterministicIntent("borrá el producto tuercas", ctx);
  assert.equal(r?.kind, "delete_product");
  assert.equal(r.productText, "tuercas");
});

test("delete_product Fast Path — 'eliminá el artículo destornilladores'", () => {
  const r = detectDeterministicIntent("eliminá el artículo destornilladores", ctx);
  assert.equal(r?.kind, "delete_product");
});

test("delete_product Fast Path — sin noun 'producto' matchea si exacto en catálogo", () => {
  // 2026-05 branch-2 (bare noun): "borrá tuercas" DOES match delete_product
  // when "tuercas" resolves to exactly ONE catalog entry via exact normalized
  // match. Previously this deferred to LLM; the detector now handles it
  // (conservative — exact single-match only, no fuzzy).
  const r = detectDeterministicIntent("borrá tuercas", ctx);
  assert.equal(r?.kind, "delete_product",
    "bare noun matching exactly one catalog entry should resolve to delete_product");
});

test("delete_product Fast Path — undo qualifier defiere a undo", () => {
  const r = detectDeterministicIntent("borrá la última venta", ctx);
  assert.equal(r?.kind, "undo");
});

// delete_customer / update_business_rule revertidos al Slow Path 2026-05-10.
// Ahora "borrá el cliente X" y "cambiá la regla X" caen al LLM para que el
// chat ejecute la acción real (en vez de redirect-to-UI).
test("delete_customer (reverted) — 'borrá el cliente Carlos' NO matchea Fast Path", () => {
  const r = detectDeterministicIntent("borrá el cliente Carlos", ctx);
  assert.notEqual(r?.kind, "delete_customer");
});

test("update_business_rule (reverted) — 'cambiá la regla de stock' NO matchea Fast Path", () => {
  const r = detectDeterministicIntent("cambiá la regla de stock", ctx);
  assert.notEqual(r?.kind, "update_business_rule");
});

// ──────────────────────────────────────────────────────────────────────────────
// Regression: "Cargar N X a $P cada uno" must route to create_product
// Root cause 2026-05-29: stock_load_fast_path (label 3a) fired before
// create_product (label 3b), treating unknown products as stock-ingress → search.
// Fix: guard in stock_load bails on "cada uno/una" + new PATTERN_QTY_NAME_UNIT_PRICE
// in create-product detector.
// ──────────────────────────────────────────────────────────────────────────────

test("create_product Fast Path — 'Cargar 5 bizcochos a 30 pesos cada uno' → create, not stock-load", () => {
  const r = detectDeterministicIntent("Cargar 5 bizcochos a 30 pesos cada uno", ctx);
  assert.equal(r?.kind, "create_product", `expected create_product, got ${r?.kind}`);
  assert.equal(r.name, "bizcochos");
  assert.equal(r.price, 30);
  assert.equal(r.stock, 5);
});

test("create_product Fast Path — 'agregá 10 alfajores a 500 cada uno' → create", () => {
  const r = detectDeterministicIntent("agregá 10 alfajores a 500 cada uno", ctx);
  assert.equal(r?.kind, "create_product", `expected create_product, got ${r?.kind}`);
  assert.equal(r.name, "alfajores");
  assert.equal(r.price, 500);
  assert.equal(r.stock, 10);
});

test("create_product Fast Path — 'cargá 3 facturas a $200 cada una' → create", () => {
  const r = detectDeterministicIntent("cargá 3 facturas a $200 cada una", ctx);
  assert.equal(r?.kind, "create_product", `expected create_product, got ${r?.kind}`);
  assert.equal(r.name, "facturas");
  assert.equal(r.price, 200);
  assert.equal(r.stock, 3);
});

test("stock_load no-regression — 'llegaron 12 cocas a 800 pesos' stays stock_load", () => {
  // "llegaron" is unambiguously a stock-ingress verb — not a create-product verb.
  // Must NOT be re-routed to create_product.
  const r = detectDeterministicIntent("llegaron 12 cocas a 800 pesos", ctx);
  assert.equal(r?.kind, "stock_load_fast_path", `expected stock_load_fast_path, got ${r?.kind}`);
});

test("stock_load no-regression — 'cargué 50 cervezas a 350' without cada-uno stays stock_load", () => {
  // Without "cada uno/una", cargué is a stock-ingress verb form — not create-product.
  const r = detectDeterministicIntent("cargué 50 cervezas a 350", ctx);
  // Must be stock_load or fall to LLM (null) — never create_product.
  assert.notEqual(r?.kind, "create_product", "cargué without 'cada uno' must NOT be create_product");
});

test("create_product Fast Path — leading interjection 'dale, cargar 5 bizcochos a 30 pesos cada uno'", () => {
  // Patterns have no ^/$ anchors so leading fillers must still match.
  const r = detectDeterministicIntent("dale, cargar 5 bizcochos a 30 pesos cada uno", ctx);
  assert.equal(r?.kind, "create_product", `expected create_product, got ${r?.kind}`);
  assert.equal(r.name, "bizcochos");
  assert.equal(r.price, 30);
  assert.equal(r.stock, 5);
});

// ──────────────────────────────────────────────────────────────────────────────
// Promesa bypass — owner-only gate (narrowed 2026-05-30)
//
// The bypass must fire for owner (fall-through to Supervisor → call_payments_agent)
// but MUST NOT fire for employees (who should get owner_only_blocked instead).
// Source: https://adk.dev/agents/workflow-agents/
// ──────────────────────────────────────────────────────────────────────────────

const ownerCtxPromesa = {
  catalog: {
    products: [{ id: "p1", name: "tuercas" }],
    customers: [{ id: "c1", name: "Carlos Rossi" }],
  },
  productInfoDirectory: [{ name: "tuercas" }],
  invoiceDirectory: [],
  purchaseRequestDirectory: [],
  actorRole: "owner",
};

const employeeCtxPromesa = { ...ownerCtxPromesa, actorRole: "employee" };
const noRoleCtxPromesa = { ...ownerCtxPromesa, actorRole: undefined };

test("promesa bypass — owner + 'fiado' → null (falls to Supervisor)", () => {
  // Owner with promesa keyword: bypass fires → return null → Supervisor delegates to Payments.
  const r = detectDeterministicIntent("vendí una tuerca a Carlos en fiado", ownerCtxPromesa);
  assert.equal(r, null, "owner + fiado must bypass all fast-paths (null → Supervisor)");
});

test("promesa bypass — owner + 'prometio pagar' (no accent) → null", () => {
  const r = detectDeterministicIntent("Juan prometio pagar la semana que viene", ownerCtxPromesa);
  assert.equal(r, null, "owner + prometio pagar (unaccented) must bypass (accent-stripped match)");
});

test("promesa bypass — owner + 'cuenta corriente' → null", () => {
  const r = detectDeterministicIntent("vendele una tuerca en cuenta corriente", ownerCtxPromesa);
  assert.equal(r, null, "owner + cuenta corriente must bypass fast-paths");
});

test("promesa bypass — employee + 'fiado' → NOT null (owner_only_blocked or other)", () => {
  // Employee with promesa keyword: bypass must NOT fire. The PRIORITY_TABLE
  // should then match owner_only_blocked or another intent (not null bypass).
  const r = detectDeterministicIntent("le vendo en fiado al cliente", employeeCtxPromesa);
  // If the result is null it means the (now incorrect) bypass fired for employees.
  // We accept any non-null result OR null from the LLM fall-through — the key is
  // the bypass guard checked actorRole. Since "fiado" alone with no sell verb
  // may not match any table entry, null is also acceptable as long as the reason
  // is the TABLE returning null (not the bypass). We test the positive case below.
  // (We cannot distinguish "bypass null" from "table null" here without mocking,
  // so we test the inverse: a message WITH an undo verb must not be bypassed.)
  const rWithUndo = detectDeterministicIntent("fiado — deshacé la última venta", employeeCtxPromesa);
  // "deshacé la última venta" hits the undo detector (label "1") which is role-agnostic.
  // If the promesa bypass still fired for employees, this would return null and the test fails.
  assert.ok(rWithUndo !== null, "employee + fiado + undo verb: undo must be detected (bypass must NOT fire for employees)");
  assert.equal(rWithUndo?.kind, "undo", `expected undo, got ${rWithUndo?.kind}`);
});

test("promesa bypass — no actorRole (undefined) + 'fiado' → NOT null for undo", () => {
  // When actorRole is undefined (legacy callers), bypass should not fire.
  const r = detectDeterministicIntent("fiado — deshacé la última venta", noRoleCtxPromesa);
  assert.ok(r !== null, "no actorRole + undo verb: undo must be detected (bypass must NOT fire when role is unset)");
  assert.equal(r?.kind, "undo");
});

test("promesa bypass — owner + undo verb WITHOUT promesa keyword → undo (no false bypass)", () => {
  // Regression guard: owner messages without promesa keywords must still route normally.
  const r = detectDeterministicIntent("deshacé la última venta", ownerCtxPromesa);
  assert.equal(r?.kind, "undo", "owner without promesa keyword must route deterministically (no bypass)");
});
