import { tLang } from "../DashboardLangContext";
import type { CreateProductData, VeloraSingleCommand } from "./shared";

export type { CreateProductData };

// Patterns for standalone product creation (not sale-driven — see
// unknown-product-flow for the voice-trained path during register_sale).
//
// Supports:
//   - "nuevo producto fernet 1L a 2500"
//   - "agregá un producto caño hierro a 50"
//   - "nuevo producto fernet a 2500, tengo 100"  (with stock)
//   - "agregá producto caño hierro precio 50 stock 100"
const CREATE_PRODUCT_PATTERNS: RegExp[] = [
  // "nuevo / agregá (un) producto NAME a|por|en PRICE [pesos] (, tengo|stock STOCK)?"
  /^(?:nuevo|agrega(?:le|me)?|agrega|agregar|nueva)\s+(?:un\s+|una\s+)?producto\s+(.+?)\s+(?:a|por|en)\s+\$?\s*(\d{1,9})\s*(?:pesos?)?\s*(?:,\s*(?:tengo|stock|inventario)\s+(\d{1,9}))?\s*$/,
  // "nuevo / agregá (un) producto NAME precio PRICE (stock STOCK)?"
  /^(?:nuevo|agrega(?:le|me)?|agrega|agregar|nueva)\s+(?:un\s+|una\s+)?producto\s+(.+?)\s+precio\s+\$?\s*(\d{1,9})\s*(?:pesos?)?\s*(?:,?\s*(?:tengo|stock|inventario)\s+(\d{1,9}))?\s*$/,
];

export function detectCreateProduct(normalized: string): VeloraSingleCommand | null {
  for (const pattern of CREATE_PRODUCT_PATTERNS) {
    const m = normalized.match(pattern);
    if (!m) continue;
    const name = m[1].trim();
    const price = Number.parseInt(m[2], 10);
    const stockStr = m[3];
    const stock = stockStr ? Number.parseInt(stockStr, 10) : null;
    if (!name || name.length < 2) continue;
    if (!Number.isFinite(price) || price <= 0) continue;
    if (stock !== null && (!Number.isFinite(stock) || stock < 0)) continue;
    return {
      matched: true,
      intent: "create_product",
      data: { name, price, stock },
    };
  }
  return null;
}

export function buildCreateProductConfirmMessage(
  data: CreateProductData,
  currency: string,
): string {
  const fmt = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: currency || "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const stockClause = data.stock !== null ? tLang(` (initial stock: ${data.stock})`, ` (stock inicial: ${data.stock})`) : "";
  return tLang(`Create product "${data.name}" at ${fmt.format(data.price)}${stockClause}?`, `¿Crear producto "${data.name}" a ${fmt.format(data.price)}${stockClause}?`);
}
