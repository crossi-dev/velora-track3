import {
  normalizeActionText,
  normalizePositiveIntegerString,
  normalizeForMatching,
} from "../shared";
import { cleanupProductName } from "./inventory-matching";

type StockAdjustmentMode = "set" | "increase" | "decrease";

export function extractStockAdjustmentFromRequest(text: string) {
  const normalized = normalizeForMatching(text);

  const contactCreationTerms = ["cliente", "clientes", "proveedor", "proveedores", "fabricante", "fabricantes"];
  if (contactCreationTerms.some((term) => normalized.includes(normalizeForMatching(term)))) {
    return { mode: "" as const, quantity: "", productName: "" };
  }

  const increaseTerms = ["agregar", "agrega", "agregale", "sumar", "suma", "sumale", "incrementar", "subir", "subi", "subile", "aumentar", "aumenta", "aumentale"];
  const decreaseTerms = ["quitar", "quita", "quitale", "restar", "resta", "restale", "bajar", "baja", "bajale", "disminuir", "disminui", "descontar", "descontale"];
  const setTerms = ["dejar", "dejalo", "dejala", "poner", "ponelo", "ponela", "cambiar", "actualizar", "editar", "ajustar"];

  const mode: StockAdjustmentMode | "" = increaseTerms.some((term) => normalized.includes(normalizeForMatching(term)))
    ? "increase"
    : decreaseTerms.some((term) => normalized.includes(normalizeForMatching(term)))
      ? "decrease"
      : setTerms.some((term) => normalized.includes(normalizeForMatching(term)))
        ? "set"
        : "";

  const stockPatterns: Array<{
    mode: StockAdjustmentMode;
    pattern: RegExp;
    productIndex: number;
    quantityIndex: number;
  }> = [
    {
      mode: "set",
      pattern: /(?:dejar|dejalo|dejala|poner|ponelo|ponela|ajustar|cambiar|actualizar|editar)\s+(?:el\s+)?(?:stock|inventario|cantidad)\s+(?:de|del)\s+(.+?)\s+(?:a|en|=|:)\s+(\d+(?:[.,]\d+)?)/i,
      productIndex: 1,
      quantityIndex: 2,
    },
    {
      mode: "set",
      pattern: /(?:dejar|dejalo|dejala|poner|ponelo|ponela)\s+(.+?)\s+(?:en|a)\s+(\d+(?:[.,]\d+)?)\s+(?:de\s+stock|en\s+stock|unidades?)?/i,
      productIndex: 1,
      quantityIndex: 2,
    },
    {
      mode: "increase",
      pattern: /(?:agregar|agrega|agregale|sumar|suma|sumale|subir|subi|subile|aumentar|aumenta|aumentale)\s+(\d+(?:[.,]\d+)?)\s*(?:unidades?)?\s+(?:al?\s+stock\s+de|a|al)\s+(.+?)(?:$|[.,;])/i,
      productIndex: 2,
      quantityIndex: 1,
    },
    {
      mode: "decrease",
      pattern: /(?:quitar|quita|quitale|restar|resta|restale|bajar|baja|bajale|disminuir|descontar|descontale)\s+(\d+(?:[.,]\d+)?)\s*(?:unidades?)?\s+(?:del?\s+stock\s+de|a|al)\s+(.+?)(?:$|[.,;])/i,
      productIndex: 2,
      quantityIndex: 1,
    },
  ];

  let quantity = "";
  let productName = "";
  let matchedMode: StockAdjustmentMode | "" = "";

  for (const entry of stockPatterns) {
    const match = text.match(entry.pattern);
    if (!match) continue;

    const extractedQuantity = normalizePositiveIntegerString(match[entry.quantityIndex] ?? "");
    const extractedProduct = cleanupProductName(normalizeActionText(match[entry.productIndex] ?? ""));
    if (extractedQuantity && extractedProduct) {
      quantity = extractedQuantity;
      productName = extractedProduct;
      matchedMode = entry.mode;
      break;
    }
    if (extractedQuantity && !quantity) quantity = extractedQuantity;
    if (extractedProduct && !productName) productName = extractedProduct;
  }

  // Fall back to text-inference mode only if no pattern set it
  if (!matchedMode) matchedMode = mode;

  if (!quantity) {
    quantity =
      normalizePositiveIntegerString(
        text.match(/\b(?:a|en|por)\s+(\d{1,6}(?:[.,]\d+)?)\s*(?:unidades?|u\b|cajas?|piezas?|items?|kg|lt?)\b/i)?.[1] ??
        text.match(/\b(?:a|en)\s+(\d{1,6})\b/i)?.[1] ?? ""
      ) || "";
  }

  if (!productName) {
    const productPatterns = [
      /(?:stock|cantidad|unidades)\s+(?:de|del)\s+(.+?)\s+(?:a|en|=|:|por)\b/i,
      /^(?:cambiar|actualizar|editar|ajustar|poner|dejar|agregar|agrega|sumar|suma|quitar|quita|restar|resta)\s+(?:\d+(?:[.,]\d+)?\s+(?:unidades?)\s+(?:al)\s+)?(?:stock|cantidad)(?:\s+(?:de|del))?\s+(.+?)(?:\s+(?:a|en|=|:|por)\b|$)/i,
      /^(?:cambiar|actualizar|editar|ajustar|poner|dejar)\s+(.+?)\s+(?:stock|cantidad)\s+(?:a|en|=|:)\b/i,
    ];

    for (const pattern of productPatterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        productName = cleanupProductName(normalizeActionText(match[1]));
        break;
      }
    }
  }

  return {
    productName,
    mode: matchedMode,
    quantity,
  };
}
