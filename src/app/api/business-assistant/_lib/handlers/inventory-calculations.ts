import {
  normalizeActionText,
  normalizeNonNegativeNumberString,
  normalizePositiveIntegerString,
  normalizeForMatching,
} from "../shared";
import { cleanupProductName, cleanupSupplierName } from "./inventory-matching";

export type ProductEditField = "name" | "price" | "costPrice" | "sku" | "stock";
type StockAdjustmentMode = "set" | "increase" | "decrease";

export function normalizeProductEditField(value: unknown): ProductEditField | "" {
  const normalized = normalizeActionText(value).toLowerCase();
  if (!normalized) return "";

  if (/^price$/i.test(normalized)) return "price";
  if (/^(?:costprice|cost_price|cost)$/i.test(normalized)) return "costPrice";
  if (/^(?:sku|code)$/i.test(normalized)) return "sku";
  if (/^name$/i.test(normalized)) return "name";

  if (/(?:^|\b)(?:precio|vale|cuesta|sale\s+a|valor)(?:\b|$)/i.test(normalized)) return "price";
  if (/(?:^|\b)(?:costo|costo\s*unitario|me\s+cuesta|costo\s+de\s+compra)(?:\b|$)/i.test(normalized)) return "costPrice";
  if (/(?:^|\b)(?:sku|codigo|código|cod)(?:\b|$)/i.test(normalized)) return "sku";
  if (/(?:^|\b)(?:stock|cantidad|unidades)(?:\b|$)/i.test(normalized)) return "stock";
  if (/(?:^|\b)(?:nombre|renombrar|se\s+llama|llamalo|llamala)(?:\b|$)/i.test(normalized)) return "name";

  return "";
}

export function inferProductEditField(text: string): ProductEditField | "" {
  const normalized = normalizeForMatching(text);

  if (/(?:^|\b)(?:sku|codigo|código|cod)(?:\b|$)/i.test(normalized)) return "sku";
  if (/(?:^|\b)(?:stock|cantidad|unidades)(?:\b|$)/i.test(normalized)) return "stock";
  if (/(?:se llama|llamalo|llamala|renombrar)\b/i.test(normalized)) return "name";
  if (/(?:\bme cuesta\b|\bcosto(?:\s+unitario)?\b|\bcosto de compra\b)/i.test(normalized)) return "costPrice";
  if (/(?:\bprecio\b|\bvale\b|\bcuesta\b|\bsale a\b|\bvalor\b)/i.test(normalized)) return "price";

  return "";
}

export function isSupportedProductEditField(field: ProductEditField | ""): field is "name" | "price" | "costPrice" | "sku" {
  return field === "name" || field === "price" || field === "costPrice" || field === "sku";
}

export function normalizeProductEditValue(field: ProductEditField | "", value: string) {
  const normalizedValue = normalizeActionText(value);
  if (!normalizedValue) return "";

  if (field === "name") return cleanupProductName(normalizedValue);
  if (field === "sku") return normalizedValue.toUpperCase();
  if (field === "price" || field === "costPrice") return normalizeNonNegativeNumberString(normalizedValue);
  return normalizedValue;
}

export function normalizeStockAdjustmentMode(value: unknown): StockAdjustmentMode | "" {
  const normalized = normalizeActionText(value).toLowerCase();
  if (!normalized) return "";

  if (/^set$/i.test(normalized)) return "set";
  if (/^increase$/i.test(normalized)) return "increase";
  if (/^decrease$/i.test(normalized)) return "decrease";

  if (/(?:^|\b)(?:actualizar|cambiar|editar|ajustar|poner|ponelo|ponela|dejar|dejalo|dejala)(?:\b|$)/i.test(normalized)) return "set";
  if (/(?:^|\b)(?:agregar|agrega|agregale|sumar|suma|sumale|incrementar|subir|subi|subile|aumentar|aumenta|aumentale)(?:\b|$)/i.test(normalized)) return "increase";
  if (/(?:^|\b)(?:quitar|quita|quitale|restar|resta|restale|reduce|bajar|baja|bajale|disminuir|disminui|descontar|descontale)(?:\b|$)/i.test(normalized)) return "decrease";

  return "";
}

export { extractStockAdjustmentFromRequest } from "./extract-stock-adjustment";

function cleanupStockItemName(value: string) {
  return normalizeActionText(value)
    .replace(
      /\b(?:valor|precio|costo|cada|c\/u|unitari[oa]|por\s+unidad|pesos?|ars|proveedor|fabricante)\b.*$/i,
      ""
    )
    .replace(/\b(?:producto|productos|ítem|ítems|articulo|articulos|artículo|artículos|nuevo|nueva)\b/gi, " ")
    .replace(/\b(?:a|al|en|para|de|del)\s+stock\b/gi, " ")
    .replace(/\bstock\b/gi, " ")
    .replace(/^(?:de|del|la|el|los|las)\s+/i, "")
    .replace(/\b(?:con|a)\s*$/i, "")
    .replace(/^[\s"'`""]+|[\s"'`"".,;:]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function findStockPriceMatch(text: string) {
  const patterns = [
    /(?:precio(?:\s+unitario)?|valor(?:\s+unitario)?|costo(?:\s+unitario)?)\s*(?::|=)?\s*\$?\s*(\d+(?:[.,]\d+)?)(?:\s*(?:pesos?|ars))?(?:\s*(?:cada\s+una|cada\s+uno|por\s+unidad|unitari[oa]|c\/u|cada))?/i,
    /\$\s*(\d+(?:[.,]\d+)?)(?:\s*(?:pesos?|ars))?(?:\s*(?:cada\s+una|cada\s+uno|por\s+unidad|unitari[oa]|c\/u|cada))?/i,
    /(\d+(?:[.,]\d+)?)\s*(?:pesos?|ars)(?:\s*(?:cada\s+una|cada\s+uno|por\s+unidad|unitari[oa]|c\/u|cada))?/i,
    /(?:a)\s+\$?\s*(\d+(?:[.,]\d+)?)(?:\s*(?:pesos?|ars))?(?:\s*(?:cada\s+una|cada\s+uno|por\s+unidad|unitari[oa]|c\/u|cada))?/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match;
  }

  return null;
}

export function extractStockDraftFromRequest(text: string) {
  const supplierMatch = text.match(
    /(?:proveedor|fabricante)\s*(?::|=|de|del)?\s*([^,;\n]+)/i
  );
  const supplierName = cleanupSupplierName(supplierMatch?.[1] ?? "");
  const priceMatch = findStockPriceMatch(text);
  const unitPrice = normalizeNonNegativeNumberString(priceMatch?.[1] ?? "");

  let workingText = text;
  if (supplierMatch?.[0]) {
    workingText = workingText.replaceAll(supplierMatch[0], " ");
  }
  if (priceMatch?.[0]) {
    workingText = workingText.replaceAll(priceMatch[0], " ");
  }

  workingText = workingText
    .replace(
      /\b(?:ingresar|ingresa|ingresan|ingreso|entrada|entra|entran|cargar|agregar|sumar|reponer|reposicion|compra|comprar|compro|compre|compré)\b/gi,
      " "
    )
    .replace(/\b(?:a|al|en|para|de|del)\s+stock\b/gi, " ")
    .replace(/[,:;]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  let quantity = "";
  let rawItemName = "";

  const quantityFirstMatch = workingText.match(/\b(\d+(?:[.,]\d+)?)\s+(.+)$/);
  if (quantityFirstMatch) {
    quantity = normalizePositiveIntegerString(quantityFirstMatch[1]);
    rawItemName = quantityFirstMatch[2];
  } else {
    const quantityLastMatch = workingText.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)$/);
    if (quantityLastMatch) {
      quantity = normalizePositiveIntegerString(quantityLastMatch[2]);
      rawItemName = quantityLastMatch[1];
    }
  }

  const itemName = cleanupStockItemName(rawItemName);

  if (!itemName && !quantity && !unitPrice && !supplierName) return null;

  return {
    itemName,
    quantity,
    unitPrice,
    supplierName,
  };
}
