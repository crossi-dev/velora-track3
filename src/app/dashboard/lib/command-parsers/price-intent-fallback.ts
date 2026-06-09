import { tLang } from "../DashboardLangContext";
import type { VeloraSingleCommand } from "./shared";

// Verbs that reveal a stock-load intent — reject here so "cargá 50 papas
// a $30, 50 peras a $40" does NOT fall through to this fallback.
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

export type PriceIntentFallbackData = Record<string, never>;

// Fires when the user clearly wants to update multiple prices but the
// upstream catalog-aware detectors (edit_product, multi-price editor)
// couldn't resolve product names — typically because STT mangled them
// ("lapapas" instead of "papas"). Without this fallback the text drops
// through to the AI, which often mis-routes to stock_load or
// bulk_price_update. Matching locally here lets the handler ask the
// user to repeat with catalog-matching names.
//
// Heuristics mirror the server-side looksLikePriceUpdateIntent
// (handlers/price-intent-detector.ts) to keep behavior parity:
//   - text contains "precio"
//   - at least 2 price-looking numbers
//   - not a bulk / percent operation (those route to bulk_price_update)
//   - not a stock-load operation (those route to stock_load)
export function detectPriceIntentFallback(normalized: string): VeloraSingleCommand | null {
  if (!normalized) return null;
  if (BULK_TOKENS.test(normalized)) return null;
  if (PERCENT_TOKENS.test(normalized)) return null;
  if (STOCK_VERBS.some((v) => normalized.includes(v))) return null;

  if (!/\bprecio/.test(normalized)) return null;

  const priceNumbers = (normalized.match(/\$?\s?\d{1,8}(?!\d)/g) ?? [])
    .map((s) => Number.parseInt(s.replace(/[\s$]/g, ""), 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 10_000_000);

  if (priceNumbers.length < 2) return null;

  return { matched: true, intent: "price_intent_fallback", data: {} };
}

// Exported for testing — the handler in commandLayer.ts emits this text.
export function buildPriceIntentFallbackReply(): string {
  return tLang(
    'I understood you want to update prices but I couldn\'t identify the products. ' +
    'Try again specifying catalog names, for example: ' +
    '"papas price $50, peras $40".',
    "Entendí que querés actualizar precios pero no identifiqué los productos. " +
    "Probá de nuevo indicando nombres del catálogo, por ejemplo: " +
    '"el precio de las papas $50, peras $40".'
  );
}
