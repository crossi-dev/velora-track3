import { normalizeForMatching } from "../shared";

const STOCK_VERBS = [
  "cargar",
  "carga",
  "cargo",
  "cargale",
  "carguemos",
  "ingresar",
  "ingresa",
  "ingreso",
  "ingresame",
  "reponer",
  "repone",
  "repongamos",
  "me llegaron",
  "me llego",
  "entraron",
  "entro",
  "tengo stock",
  "pedimos",
  "pedi",
];

const BULK_TOKENS = /\b(todos?|todas?|cada\s+(?:uno|una)|cualquier)\b/;
const PERCENT_TOKENS = /\b(porcentaje|porciento|%|\d+\s*%)/;

// Detects user intent to update multiple prices without requiring catalog
// resolution. Used as a fallback when the catalog-aware detector failed
// (typically because STT mangled product names). Lets the pre-model router
// return an explicit clarification instead of letting the model mis-route
// to stock_load or bulk_price_update.
export function looksLikePriceUpdateIntent(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatching(text);

  if (BULK_TOKENS.test(normalized)) return false;
  if (PERCENT_TOKENS.test(normalized)) return false;
  if (STOCK_VERBS.some((v) => normalized.includes(v))) return false;

  const precioOccurrences = (normalized.match(/\bprecio/g) ?? []).length;
  if (precioOccurrences < 1) return false;

  const priceNumbers = (normalized.match(/\$?\s?\d{1,8}(?!\d)/g) ?? [])
    .map((s) => Number.parseInt(s.replace(/[\s$]/g, ""), 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 10_000_000);

  return priceNumbers.length >= 2;
}

// Detecta intentos de editar el precio de UN producto: "cambia el precio
// de tuercas a 80", "poné el precio del destornillador en 100", "el precio
// de X que sea Y". Usado pre-model para que RBAC pueda rebotar al empleado
// con voz cálida en vez de dejar que el modelo (a) lo interprete como
// query y devuelva el precio actual, o (b) lo emita como edit_product y
// dependa del gate downstream.
//
// Distingue de looksLikePriceUpdateIntent (multi-producto, ≥2 números) en
// que aquí esperamos exactamente 1 número y verbos de edición explícitos.
const EDIT_VERBS = /\b(cambia|cambi[áa]|cambialo|cambiale|cambiar|pon[eé]|poner|pon[eé]le|cambia\s+el\s+precio|pasa(?:le)?|deja(?:le)?|que\s+sea|que\s+valga|sub(?:i|í)(?:le)?|baja(?:le)?)\b/;
const PRICE_NOUN = /\b(precio|valor|costo|cuesta|vale)\b/;

export function looksLikeSinglePriceEditIntent(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeForMatching(text);

  // Excluye bulk y porcentajes (van por bulk_price_update path).
  if (BULK_TOKENS.test(normalized)) return false;
  if (PERCENT_TOKENS.test(normalized)) return false;
  if (STOCK_VERBS.some((v) => normalized.includes(v))) return false;

  // Tiene que mentar precio Y un verbo de edición.
  if (!PRICE_NOUN.test(normalized)) return false;
  if (!EDIT_VERBS.test(normalized)) return false;

  // Y exactamente 1 número (target price). 0 → ambiguo, ≥2 → multi-product.
  const priceNumbers = (normalized.match(/\$?\s?\d{1,8}(?!\d)/g) ?? [])
    .map((s) => Number.parseInt(s.replace(/[\s$]/g, ""), 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 10_000_000);

  return priceNumbers.length === 1;
}
