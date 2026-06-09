// Deterministic detectors for owner-only intents — used to fire warm RBAC
// rejects before any LLM call. Without these, the companion LLM may either
// hallucinate a successful destructive action ("Producto borrado") or return
// a generic "no entendí" — both bad UX.
//
// Each detector returns true if the text *clearly* expresses the intent.
// Conservative bias: false negatives are fine (LLM gets a shot), false
// positives bounce a legitimate query — so anchor verbs + topic noun.

import type { AssistantIntent } from "../types";
import { normalizeForMatching } from "../shared";

const DELETE_VERBS = /\b(borr[aá]|borrar|elimin[aá]|eliminar|sac[aá]r?|saca|quita[rl]?|quita|remove[rl]?)\b/;
const PRODUCT_NOUN = /\b(producto|articulo|art[íi]culo|item|cat[áa]logo|catalogo)\b/;

export function looksLikeDeleteProduct(text: string, productNames: string[]): boolean {
  const t = normalizeForMatching(text);
  if (!DELETE_VERBS.test(t)) return false;
  if (PRODUCT_NOUN.test(t)) return true;
  for (const name of productNames) {
    const norm = normalizeForMatching(name);
    if (!norm) continue;
    if (t.includes(norm)) return true;
    // singular form (drop trailing 's')
    if (norm.endsWith("s") && t.includes(norm.slice(0, -1))) return true;
  }
  return false;
}

const BULK_PRICE_RE = [
  /\b(sub[ií]r?|sub[ií]|aumenta[rl]?|aument[aá]|baj[aá]r?|baj[aá])\b.{0,40}\b(todo|todos|todas)\b.{0,40}\b(precio|precios|cat[áa]logo|catalogo)\b/,
  /\b(sub[ií]r?|sub[ií]|aumenta[rl]?|aument[aá])\b.{0,40}\b(todo|todos)\b.{0,40}\bun?\s*\d+\s*(%|por\s+ciento)/,
  /\b(sub[ií]r?|sub[ií]|aumenta[rl]?|aument[aá])\b.{0,30}\bun?\s*\d+\s*(%|por\s+ciento)\b.{0,40}\b(todo|todos|cat[áa]logo|catalogo|precio)/,
];

export function looksLikeBulkPriceUpdate(text: string): boolean {
  const t = normalizeForMatching(text);
  return BULK_PRICE_RE.some((re) => re.test(t));
}

const ADJUST_STOCK_RE = [
  /\b(ajust[aá]r?|ajust[aá]|corregi[rl]?|corregi|corrige|seteo|seteale|set[eé]a|pon[eé]le|ponele|deja[rl]?\s+en|dejar\s+en)\b.{0,40}\b(stock|inventario|unidades?)\b/,
  /\b(ponele|pon[eé]le|set[eé]a)\b.{0,20}\d+\s*(unidades?|u\.?)\s+(de\s+)?(stock|inventario)/,
  /\bstock\b.{0,30}\b(de|del)\b.{0,30}\b(a|en)\s+\d+/,
];

export function looksLikeAdjustStock(text: string): boolean {
  const t = normalizeForMatching(text);
  return ADJUST_STOCK_RE.some((re) => re.test(t));
}

const MOVEMENT_RE = [
  /\b(registra[rl]?|registr[aá]|anot[aá]r?|anot[aá]|carg[aá]r?|carg[aá])\b.{0,40}\b(gasto|ingreso|egreso|movimiento|caja)\b/,
  /\b(gasto|ingreso|egreso)\b.{0,20}\bde\s+\$?\d/,
  /\b(ingreso|egreso|movimiento)\b.{0,20}\b(a|en)\s+caja\b/,
  /\b(pag[uú]é|pagamos|gastamos|gast[eé])\b.{0,30}\b(luz|agua|alquiler|expensas|sueldo|servicio)\b/,
];

export function looksLikeRegisterMovement(text: string): boolean {
  const t = normalizeForMatching(text);
  return MOVEMENT_RE.some((re) => re.test(t));
}

const EDIT_CUSTOMER_RE = [
  /\b(cambia[lr]e?|actualiz[aá]r?|actualiz[aá]|edit[aá]r?|edit[aá]|modific[aá]r?|modific[aá]|corregi[rl]?|corregi|corrige)\b.{0,40}\b(tel[eé]fono|telefono|cel|celular|mail|email|correo|cuit|cuil|nombre|direcci[óo]n)\b.{0,40}\b(a|al|del?|de\s+l[ao]s?)\s+\w+/,
  /\b(cambia[lr]e?|actualiz[aá]r?|actualiz[aá]|modific[aá]r?|modific[aá])\b.{0,30}\b(el|la)\b.{0,30}\b(tel[eé]fono|telefono|cel|celular|mail|email|correo)\b.{0,30}\b(de|del|a)\b/,
  /\b(cambia[lr]e?|actualiz[aá]r?|actualiz[aá]|modific[aá]r?|modific[aá])\b.{0,40}\bcliente\b/,
];

export function looksLikeEditCustomer(text: string, customerNames: string[]): boolean {
  const t = normalizeForMatching(text);
  if (EDIT_CUSTOMER_RE.some((re) => re.test(t))) {
    // disambiguate from edit_supplier — must NOT mention proveedor
    if (/\bproveedor(es)?\b/.test(t)) return false;
    return true;
  }
  // pattern: "actualizá el mail de Felix"
  if (/\b(cambia|actualiz|edit|modific|corregi|cambiale|cambialo)\w*\b/.test(t)) {
    for (const name of customerNames) {
      const norm = normalizeForMatching(name);
      if (!norm) continue;
      const first = norm.split(" ")[0];
      if (first && first.length >= 3 && t.includes(first)) {
        if (/\bproveedor(es)?\b/.test(t)) return false;
        if (/\b(tel[eé]fono|telefono|cel|celular|mail|email|correo|cuit|cuil|direcci[óo]n)\b/.test(t)) {
          return true;
        }
      }
    }
  }
  return false;
}

const CREATE_PRODUCT_RE = [
  /\b(agreg[aá]r?|agreg[aá]|sum[aá]r?|sum[aá]|cre[aá]r?|cre[aá]|carg[aá]r?|carg[aá]|nuev[oa])\b.{0,40}\b(producto|articulo|art[íi]culo|item)\b/,
  /\b(agreg[aá]r?|sum[aá]r?|carg[aá]r?|cre[aá]r?)\b.{0,5}\b(un|una|uno)?\b.{0,30}\b(producto|articulo|art[íi]culo)\s+nuev[oa]\b/,
  /\bcarg[aá](r|me|le)?\b.{0,30}\bcon\s+precio\s+\$?\d/,
  /\bproducto\s+nuev[oa]\b/,
];

export function looksLikeCreateProduct(text: string): boolean {
  const t = normalizeForMatching(text);
  return CREATE_PRODUCT_RE.some((re) => re.test(t));
}

const SUPPLIER_NOUN = /\bproveedor(es)?\b/;
const CREATE_VERBS = /\b(agreg[aá]r?|agreg[aá]|sum[aá]r?|sum[aá]|cre[aá]r?|cre[aá]|carg[aá]r?|carg[aá]|nuev[oa])\b/;
const EDIT_VERBS = /\b(cambia[lr]e?|actualiz[aá]r?|actualiz[aá]|edit[aá]r?|edit[aá]|modific[aá]r?|modific[aá]|corregi[rl]?|corregi|corrige)\b/;

// "dar de alta" — canonical AR administrative verb for registering a new entity.
// "quiero dar de alta un proveedor" must fire create_supplier. Gap 9 — NLU
// comprehension audit 2026-05-28 (agent ab2c390e63637a524).
//
// M3 fix — JD adversarial review Step 1, 2026-05-28.
// Original: /\bd[ao]r?\s+de\s+alta\b/ — too permissive.
// d[ao]r? produces 6 forms: da, dao, do, dor, doa, dar — but only "dar"
// (infinitive) and "da" (voseo imperative, e.g. "da de alta al proveedor")
// are valid Spanish. "dor"/"do" are typos that should fall through to LLM.
const DAR_DE_ALTA_RE = /\b(?:dar|da)\s+de\s+alta\b/i;

export function looksLikeCreateSupplier(text: string): boolean {
  const t = normalizeForMatching(text);
  if (!SUPPLIER_NOUN.test(t)) return false;
  return CREATE_VERBS.test(t) || /\bnuevo\s+proveedor\b/.test(t) || DAR_DE_ALTA_RE.test(t);
}

export function looksLikeEditSupplier(text: string): boolean {
  const t = normalizeForMatching(text);
  if (!SUPPLIER_NOUN.test(t)) return false;
  return EDIT_VERBS.test(t);
}

// delete_supplier — owner-only destructive op. Anchored on supplier noun +
// destructive verb (mirrors looksLikeDeleteProduct, but supplier-scoped).
// Conservative bias: requires the word "proveedor(es)" to fire — same rule
// as create/edit supplier — so we don't bounce legit deletes for products,
// customers, employees, rules, etc. that happen to share destructive verbs.
export function looksLikeDeleteSupplier(text: string): boolean {
  const t = normalizeForMatching(text);
  if (!SUPPLIER_NOUN.test(t)) return false;
  return DELETE_VERBS.test(t);
}

const CUSTOMER_NOUN = /\bcliente(s)?\b/;

// delete_customer — owner-only destructive op. Anchored on customer noun +
// destructive verb. Conservative bias: requires "cliente(s)" to avoid
// colliding with delete_product or delete_supplier when the user says
// "borrar" without a clear scope noun.
export function looksLikeDeleteCustomer(text: string): boolean {
  const t = normalizeForMatching(text);
  if (!CUSTOMER_NOUN.test(t)) return false;
  return DELETE_VERBS.test(t);
}

// delete_sale_item — employee asks to remove a specific product from the
// active sale draft ("borrame el agua de la venta", "sacá la coca del pedido").
// This is owner-only: employees can build a sale draft but cannot mutate
// individual line items — that requires the owner's confirmation flow.
//
// Pattern: delete-verb + optional article + product fragment + sale-context noun.
// The sale-context noun ("venta", "pedido", "lista", "draft") distinguishes
// this from a plain delete_product (which references the catalog directly).
// Matches BEFORE delete_product in detectOwnerOnlyIntent to avoid mis-routing.
const DELETE_SALE_ITEM_RE =
  /\b(?:borr\w*|sac\w*|quit\w*|elimin\w*|remov\w*|tira\w*)\b.{0,40}\b(de\s+la\s+(?:venta|lista|orden)|del\s+(?:pedido|draft|carrito))\b/i;

export function looksLikeDeleteSaleItem(text: string): boolean {
  const t = normalizeForMatching(text);
  return DELETE_SALE_ITEM_RE.test(t);
}

const BUDGET_RE = [
  /\b(arm[aá]r?|arm[aá]|gener[aá]r?|gener[aá]|cre[aá]r?|cre[aá]|hac[eé]r?|hac[eé]|hacele|hacele|prepar[aá]r?|prepar[aá])\b.{0,40}\b(presupuesto|cotizaci[óo]n|cotizacion|quote)\b/,
  /\b(presupuesto|cotizaci[óo]n|cotizacion)\b.{0,40}\b(para|al|del?|cliente)\b/,
];

export function looksLikeCreateBudget(text: string): boolean {
  const t = normalizeForMatching(text);
  return BUDGET_RE.some((re) => re.test(t));
}

const PURCHASE_REQ_RE = [
  /\b(ped[ií][rl]?e?|hac[eé]r?\s+pedido|encarg[aá]r?)\b.{0,40}\b(a|al)\b.{0,40}\b(proveedor|distribuidor|distribuidora)\b/,
  /\b(arm[aá]r?|arm[aá]|gener[aá]r?|gener[aá]|cre[aá]r?|cre[aá])\b.{0,30}\b(orden\s+de\s+compra|pedido\s+a|orden\s+a)\b/,
  /\borden\s+de\s+compra\b/,
  /\bped[ií][rl]?e?\s+a\s+\w+.{0,30}\b\d+\b/,
];

export function looksLikeCreatePurchaseRequest(text: string): boolean {
  const t = normalizeForMatching(text);
  return PURCHASE_REQ_RE.some((re) => re.test(t));
}

/**
 * Composite: detects any owner-only intent expressed clearly enough to
 * deterministically warm-reject. Returns the canonical AssistantIntent
 * name so the caller can build the right warm refusal message.
 *
 * Order matters — most specific first to avoid mis-tagging (e.g. budget
 * before generic create, supplier before customer when both verbs match).
 */
export function detectOwnerOnlyIntent(
  text: string,
  catalog: { products: Array<{ name: string }>; customers: Array<{ name: string }> },
): AssistantIntent | null {
  if (!text || text.trim().length === 0) return null;

  if (looksLikeCreateBudget(text)) return "create_budget";
  if (looksLikeCreatePurchaseRequest(text)) return "create_purchase_request";
  if (looksLikeDeleteSupplier(text)) return "delete_supplier";
  if (looksLikeDeleteCustomer(text)) return "delete_customer";
  if (looksLikeCreateSupplier(text)) return "create_supplier";
  if (looksLikeEditSupplier(text)) return "edit_supplier";
  if (looksLikeBulkPriceUpdate(text)) return "bulk_price_update";
  if (looksLikeAdjustStock(text)) return "adjust_stock";
  if (looksLikeRegisterMovement(text)) return "register_movement";
  // looksLikeDeleteSaleItem is intentionally NOT here — sale-item removal
  // escalates to the owner via B1 permission flow, not a flat warm reject.
  // Intercepted in nlu/detect.ts (step 0a) before this function runs.
  if (looksLikeDeleteProduct(text, catalog.products.map((p) => p.name))) return "delete_product";
  if (looksLikeCreateProduct(text)) return "create_product";
  if (looksLikeEditCustomer(text, catalog.customers.map((c) => c.name))) return "edit_customer";

  return null;
}
