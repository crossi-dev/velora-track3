import { tLang } from "../DashboardLangContext";
import {
  cleanProductName,
  resolveProductName,
  type ProductCatalogItem,
  type VeloraSingleCommand,
} from "./shared";

// Matches single-product price updates. Multi-product statements
// ("precio de X $50, precio de Y $40") and bulk updates ("subí todos 10%")
// route to other intents — this detector rejects bulk tokens explicitly.
//
// Ordering: patterns with explicit "precio de" come first so the product
// name fragment doesn't get captured as "precio de X".
// Article alternation: each variant requires trailing \s+ so the engine
// doesn't pick "la" from "las" (leftmost-wins) and leave a stray "s " in
// the captured product fragment. Same principle applied in pattern 2.
const EDIT_PRODUCT_PATTERNS: RegExp[] = [
  // "cambiá / actualizá / poné (el) precio de(l) X a Y"
  /^(?:actualiza(?:le|me)?|actualizar|pone(?:le|me)?|poner|cambia(?:le|me)?)\s+(?:el\s+)?precio\s+(?:de|del)\s+(?:la\s+|las\s+|el\s+|los\s+)?(.+?)\s+a\s+\$?\s*(\d+)\s*(?:pesos?)?\s*$/,
  // "(el) precio de(l) X (ahora )?(es|son|va|queda|cuesta|sale|vale) Y"
  /^(?:el\s+)?precio\s+(?:de|del)\s+(?:la\s+|las\s+|el\s+|los\s+)?(.+?)\s+(?:ahora\s+)?(?:es|son|va|queda|cuesta|sale|vale)\s+\$?\s*(\d+)\s*(?:pesos?)?\s*$/,
  // "cambiá / actualizá / poné X a Y" (without "el precio de")
  /^(?:actualiza(?:le|me)?|actualizar|pone(?:le|me)?|poner|cambia(?:le|me)?)\s+(?:el\s+|la\s+|los\s+|las\s+)?(.+?)\s+a\s+\$?\s*(\d+)\s*(?:pesos?)?\s*$/,
  // "la yerba sale/vale/cuesta Y"
  /^(?:la|las|el|los)\s+(.+?)\s+(?:sale|vale|cuesta)\s+\$?\s*(\d+)\s*(?:pesos?)?\s*$/,
];

export interface EditProductData {
  productName: string;
  productId: string | null;
  newPrice: number;
}

export function detectEditProduct(
  normalized: string,
  products: ProductCatalogItem[]
): VeloraSingleCommand | null {
  if (/\btodos?\b|\btodas?\b|%/.test(normalized)) return null;

  for (const pattern of EDIT_PRODUCT_PATTERNS) {
    const m = normalized.match(pattern);
    if (!m) continue;
    const productName = cleanProductName(m[1].trim());
    const newPrice = Number.parseInt(m[2], 10);
    if (!productName || !Number.isFinite(newPrice) || newPrice <= 0) continue;
    const productMatch = resolveProductName(productName, products);
    return {
      matched: true,
      intent: "edit_product",
      data: { productName, productId: productMatch?.id ?? null, newPrice },
    };
  }
  return null;
}

// Pure helper exported for testing: builds the confirmation message shown
// in the card BEFORE the user taps Confirmar. Currency formatted in es-AR
// to match the rest of the app.
export function buildEditProductConfirmMessage(
  productName: string,
  newPrice: number,
  currency: string
): string {
  const fmt = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: currency || "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return tLang(`Confirm price for ${productName}: ${fmt.format(newPrice)}?`, `¿Confirmar precio de ${productName}: ${fmt.format(newPrice)}?`);
}
