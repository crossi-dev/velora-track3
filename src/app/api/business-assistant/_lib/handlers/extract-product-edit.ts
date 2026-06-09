import {
  normalizeActionText,
  normalizeNonNegativeNumberString,
  normalizeForMatching,
} from "../shared";
import { cleanupProductName } from "./inventory-matching";
import { inferProductEditField, type ProductEditField } from "./inventory-calculations";

// Hoisted: regex literals that don't depend on runtime fieldPattern. Hot-path
// NLU was recompiling these on every turn. Module-level constants are compiled
// once at import. Source: debt audit C5.
const NUMERIC_EDIT_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:cambiar|cambia|actualizar|actualiza|editar|edita|modificar|modifica|poner|pone|ponelo|ponela|subi|subir|subile|aumenta|aumentar|aumentale|baja|bajar|bajale|reducir|reduce|reducile)\s+(?:el\s+)?(?:precio|vale|cuesta|sale a|valor|costo(?:\s+unitario)?|costo de compra|me cuesta)\s+(?:de|del)\s+(.+?)\s+(?:a|en|=|:)\s*\$?\s*([\d.,]+)/i,
  /(?:precio|vale|cuesta|sale a|valor|costo(?:\s+unitario)?|costo de compra|me cuesta)\s+(?:de|del)\s+(.+?)\s+(?:a|en|=|:)?\s*\$?\s*([\d.,]+)/i,
  /(?:producto|ítem|articulo|artículo)\s+(.+?)\s+(?:vale|cuesta|sale a|me cuesta)\s*\$?\s*([\d.,]+)/i,
];

const RENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:renombrar|cambiar|actualizar|editar|modificar)\s+(?:el\s+)?(?:nombre\s+del\s+)?(?:producto|ítem|articulo|artículo)?\s*(.+?)\s+(?:a)\s+([^,;\n]+)/i,
  /(?:producto|ítem|articulo|artículo)\s+(.+?)\s+(?:se llama|llamalo|llamala)\s+([^,;\n]+)/i,
];

const PRICE_PATTERNS: ReadonlyArray<RegExp> = [
  /(?:producto|ítem|articulo|artículo)\s+(.+?)\s+(?:vale|cuesta|sale a)\s*\$?\s*([\d.,]+)/i,
  /(?:subi|subir|subile|aumenta|aumentar|aumentale|baja|bajar|bajale|reducir|reduce|reducile)\s+(?:el\s+)?(?:precio\s+de\s+)?(.+?)\s+(?:a|en)\s*\$?\s*([\d.,]+)/i,
];

export function extractProductEditFromRequest(text: string) {
  const normalized = normalizeForMatching(text);
  const fieldCandidates: Array<{ field: ProductEditField; terms: string[] }> = [
    { field: "price", terms: ["precio", "vale", "cuesta", "sale a", "valor"] },
    { field: "costPrice", terms: ["costo unitario", "costo de compra", "me cuesta", "costo"] },
    { field: "sku", terms: ["sku", "codigo", "código", "cod"] },
    { field: "stock", terms: ["stock", "cantidad", "unidades"] },
    { field: "name", terms: ["nombre", "renombrar", "se llama", "llamalo", "llamala"] },
  ];

  let selectedField: ProductEditField | "" = "";
  let fieldTerms: string[] = [];
  const matches = fieldCandidates.filter(({ terms }) => terms.some((term) => normalized.includes(normalizeForMatching(term))));

  if (matches.length === 1) {
    selectedField = matches[0].field;
    fieldTerms = matches[0].terms;
  } else if (matches.length === 0) {
    selectedField = inferProductEditField(text);
    if (selectedField === "price") fieldTerms = ["precio", "vale", "cuesta", "sale a", "valor"];
    if (selectedField === "costPrice") fieldTerms = ["costo unitario", "costo de compra", "me cuesta", "costo"];
    if (selectedField === "sku") fieldTerms = ["sku", "codigo", "código", "cod"];
    if (selectedField === "stock") fieldTerms = ["stock", "cantidad", "unidades"];
    if (selectedField === "name") fieldTerms = ["renombrar", "nombre", "se llama", "llamalo", "llamala"];
    if (!selectedField) return null;
  } else {
    return null;
  }

  const fieldPattern = fieldTerms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const valuePatterns = [
    new RegExp(`(?:${fieldPattern})\\s*(?:to|a|=|:)\\s*([^,;\\n]+)`, "i"),
    new RegExp(`(?:${fieldPattern})\\s+([^,;\\n]+)`, "i"),
  ];

  let productName = "";
  let value = "";

  if (selectedField === "price" || selectedField === "costPrice") {
    for (const pattern of NUMERIC_EDIT_PATTERNS) {
      const match = text.match(pattern);
      const normalizedNumericValue = normalizeNonNegativeNumberString(match?.[2] ?? "");
      if (!match?.[1] || !normalizedNumericValue) continue;

      productName = cleanupProductName(normalizeActionText(match[1]));
      value = normalizedNumericValue;
      break;
    }
  }

  // Skip generic valuePatterns for "name" field — renamePatterns below handle it correctly
  if (!value && selectedField !== "name") {
    for (const pattern of valuePatterns) {
      const match = text.match(pattern);
      if (match?.[1]) {
        const candidateValue = normalizeActionText(match[1]);
        if (selectedField === "price" || selectedField === "costPrice") {
          const normalizedNumericValue = normalizeNonNegativeNumberString(candidateValue);
          if (!normalizedNumericValue) continue;
          value = normalizedNumericValue;
        } else if (selectedField === "sku") {
          value = candidateValue;
        } else {
          value = candidateValue;
        }
        break;
      }
    }
  }

  if (!value && selectedField === "name") {
    let renameMatch: RegExpMatchArray | null = null;
    for (const pattern of RENAME_PATTERNS) {
      renameMatch = text.match(pattern);
      if (renameMatch) break;
    }
    if (renameMatch?.[2]) {
      value = normalizeActionText(renameMatch[2]);
      if (!productName && renameMatch[1]) {
        productName = cleanupProductName(normalizeActionText(renameMatch[1]));
      }
    }
  }

  if (!value && selectedField === "price") {
    for (const pattern of PRICE_PATTERNS) {
      const match = text.match(pattern);
      const normalizedNumericValue = normalizeNonNegativeNumberString(match?.[2] ?? "");
      if (normalizedNumericValue) {
        if (!productName && match?.[1]) {
          productName = cleanupProductName(normalizeActionText(match[1]));
        }
        value = normalizedNumericValue;
        break;
      }
    }
  }

  if (!value && selectedField === "costPrice") {
    const costPatterns = [
      /(?:producto|ítem|articulo|artículo)\s+(.+?)\s+(?:me cuesta|costo(?:\s+unitario)?)\s*\$?\s*([\d.,]+)/i,
      /(?:subi|subir|subile|aumenta|aumentar|aumentale|baja|bajar|bajale|reducir|reduce|reducile)\s+(?:el\s+)?(?:costo(?:\s+unitario)?\s+de\s+)?(.+?)\s+(?:a|en)\s*\$?\s*([\d.,]+)/i,
    ];
    for (const pattern of costPatterns) {
      const match = text.match(pattern);
      const normalizedNumericValue = normalizeNonNegativeNumberString(match?.[2] ?? "");
      if (normalizedNumericValue) {
        if (!productName && match?.[1]) {
          productName = cleanupProductName(normalizeActionText(match[1]));
        }
        value = normalizedNumericValue;
        break;
      }
    }
  }

  const productPatterns = [
    new RegExp(`(?:producto|ítem|articulo|artículo)\\s+(.+?)\\s+(?:${fieldPattern})\\b`, "i"),
    new RegExp(`^(?:cambiar|actualizar|editar|modificar|poner)(?:\\s+(?:el))?(?:\\s+(?:producto|ítem|articulo|artículo))?\\s+(.+?)\\s+(?:${fieldPattern})\\b`, "i"),
    /(?:subi|subir|subile|aumenta|aumentar|aumentale|baja|bajar|bajale|reducir|reduce|reducile)\s+(?:el\s+)?(?:precio|costo(?:\s+unitario)?)\s+(?:de|del)\s+(.+?)\s+(?:a|en)\b/i,
    /(.+?)\s+(?:vale|cuesta|sale a|me cuesta)\s+\d+(?:[.,]\d+)?/i,
    /(?:producto|ítem|articulo|artículo)\s+(.+?)\s+(?:se llama|llamalo|llamala)\b/i,
  ];

  if (!productName) {
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
    field: selectedField,
    value,
  };
}
