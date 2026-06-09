import {
  parseItemList,
  resolveProductName,
  type ProductCatalogItem,
  type StockLoadLineItem,
  type VeloraSingleCommand,
} from "./shared";

// Inbound stock verbs. Includes "traje/trajimos/trajeron" (to bring) —
// user's common phrasing for receiving stock from a supplier run.
const STOCK_LOAD_VERBS_RE =
  /\b(me\s+llego(?:n)?|me\s+llegaron|llegaron|carga(?:le|me)?|cargar|ingresa(?:le|me)?|ingresar|entraron|entro|repuse|repusimos|recibi|recibimos|pedi|pedimos|me\s+vinieron|vinieron|traje|trajimos|trajeron|traigo)\b/;

export function detectStockLoad(
  normalized: string,
  products: ProductCatalogItem[]
): VeloraSingleCommand | null {
  const verbMatch = normalized.match(STOCK_LOAD_VERBS_RE);
  if (!verbMatch || verbMatch.index === undefined) return null;

  const afterVerb = normalized.slice(verbMatch.index + verbMatch[0].length).trim();
  if (!afterVerb) return null;

  const parsedItems = parseItemList(afterVerb);
  if (parsedItems.length === 0) return null;

  const items: StockLoadLineItem[] = parsedItems.map((item) => {
    const match = resolveProductName(item.productName, products);
    return {
      productName: item.productName,
      productId: match?.id ?? null,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    };
  });

  return {
    matched: true,
    intent: "stock_load",
    data: { items },
  };
}
