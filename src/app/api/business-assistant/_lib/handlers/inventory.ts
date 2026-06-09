import {
  chooseLongerText,
  normalizeActionText,
  normalizePositiveIntegerString,
} from "../shared";
import type { AssistantTaskModelResponse, ProductInfoEntry } from "../types";
import { cleanupProductName, findBestProductMatch } from "./inventory-matching";
import { computeNameMatchScore } from "./match-score";
import { extractProductEditFromRequest } from "./extract-product-edit";
import {
  extractStockAdjustmentFromRequest,
  isSupportedProductEditField,
  normalizeProductEditField,
  normalizeProductEditValue,
  normalizeStockAdjustmentMode,
} from "./inventory-calculations";
import { productEditClarification, stockAdjustmentClarification } from "./inventory-responses";

export { findProductInfoMatch, looksLikeQuestionStyleRequest } from "./inventory-matching";

export { extractProductEditFromRequest } from "./extract-product-edit";
export {
  extractStockAdjustmentFromRequest,
  extractStockDraftFromRequest,
} from "./inventory-calculations";

export {
  buildInventorySummaryAnswer,
  buildProductStockAnswer,
  stockLoadClarification,
} from "./inventory-responses";

export {
  looksLikeDeleteProductRequest,
  looksLikeEditProductRequest,
  looksLikeStockAdjustmentRequest,
  looksLikeStockLoadRequest,
} from "./inventory-detectors";

export function resolveProductEditRequest(
  text: string,
  parsed: AssistantTaskModelResponse,
  products: { id: string; name: string; sku?: string | null }[]
) {
  const fallbackEdit = extractProductEditFromRequest(text);
  const field = normalizeProductEditField(parsed.productEdit?.field) || fallbackEdit?.field || "";
  const value = normalizeProductEditValue(
    field,
    normalizeActionText(parsed.productEdit?.value) || fallbackEdit?.value || ""
  );
  const matchedProductId = normalizeActionText(parsed.matchedProductId);
  const parsedProductName = chooseLongerText(
    cleanupProductName(normalizeActionText(parsed.product?.name)),
    fallbackEdit?.productName || ""
  );
  if (!field) {
    return { clarification: productEditClarification("missing_field") };
  }

  if (!isSupportedProductEditField(field)) {
    return { clarification: productEditClarification("unsupported_field") };
  }

  if (!value) {
    return { clarification: productEditClarification("missing_value") };
  }

  const matchedProduct =
    matchedProductId ? products.find((product) => product.id === matchedProductId) ?? null : null;

  if (matchedProduct) {
    return {
      action: {
        type: "edit_product" as const,
        product: {
          id: matchedProduct.id,
          name: matchedProduct.name,
        },
        field,
        value,
      },
    };
  }

  if (!parsedProductName) {
    return { clarification: productEditClarification("missing_product") };
  }

  const productMatch = findBestProductMatch(parsedProductName, products);
  if (productMatch.ambiguous) {
    return { clarification: productEditClarification("ambiguous_product") };
  }

  if (!productMatch.match) {
    return { clarification: productEditClarification("missing_product") };
  }

  return {
    action: {
      type: "edit_product" as const,
      product: {
        id: productMatch.match.id,
        name: productMatch.match.name,
      },
      field,
      value,
    },
  };
}

export function resolveProductDeleteRequest(
  text: string,
  products: { id: string; name: string; sku?: string | null }[],
) {

  const productTermPatterns = [
    /(?:eliminar?|eliminá|borrar?|borrá|borrame|borrale|quitar?|quitá|quitame|quitale|sacar?|sacá|sacame|sacale|remover?|remové|dar\s+(?:de\s+)?baja)\s+(?:el\s+|la\s+|este\s+|esta\s+)?(?:producto|ítem|item|articulo|artículo)?\s+(.+)/i,
    /(?:producto|ítem|item|articulo|artículo)\s+(.+?)\s+(?:eliminar?|eliminá|borrar?|borrá|quitar?|quitá|sacar?|sacá|dar\s+(?:de\s+)?baja)/i,
    /(?:eliminar?|eliminá|borrar?|borrá|quitar?|quitá|sacar?|sacá|dar\s+(?:de\s+)?baja)\s+(.+)/i,
  ];

  let rawProductName = "";
  for (const pattern of productTermPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      rawProductName = cleanupProductName(normalizeActionText(match[1]));
      break;
    }
  }

  if (!rawProductName) {
    return {
      clarification: {
        answer: "¿Cuál es el nombre del producto que querés eliminar?",
        questionContext: "delete_product_name",
        inputHint: "Nombre del producto",
      },
    };
  }

  const productMatch = findBestProductMatch(rawProductName, products);

  if (productMatch.ambiguous) {
    return {
      clarification: {
        answer: `Encontré varios productos con ese nombre. ¿Cuál querés eliminar? Escribí el nombre exacto.`,
        questionContext: "delete_product_name",
        inputHint: "Nombre exacto del producto",
      },
    };
  }

  if (!productMatch.match) {
    return {
      clarification: {
        answer: `No encontré ningún producto con el nombre "${rawProductName}". Revisá el nombre e intentá de nuevo.`,
        questionContext: "delete_product_name",
        inputHint: "Nombre del producto",
      },
    };
  }

  // Guard: fuzzy match below threshold — require the owner to confirm the
  // candidate name before the deletion action is dispatched.
  // computeNameMatchScore returns 100 for exact and 80 for substring.
  // Threshold 90 ensures only exact normalized matches proceed silently.
  const deleteMatchScore = computeNameMatchScore(rawProductName, productMatch.match.name, true);
  if (deleteMatchScore < 90) {
    const candidate = { id: productMatch.match.id, name: productMatch.match.name };
    return {
      clarification: {
        answer: `¿Quisiste decir "${candidate.name}"? Confirmá si querés borrar ese producto.`,
        questionContext: "delete_product_confirm_candidate",
        inputHint: `Escribí "sí" para confirmar`,
        confirmationRequest: {
          id: crypto.randomUUID(),
          severity: "warning" as const,
          title: "Confirmar producto a eliminar",
          message: `No encontré "${rawProductName}" exactamente. ¿Eliminar "${candidate.name}"? Esta acción no se puede deshacer.`,
          confirmLabel: "Eliminar",
          cancelLabel: "Cancelar",
          action: { type: "delete_product" as const, product: candidate },
        },
      },
    };
  }

  return {
    action: {
      type: "delete_product" as const,
      product: {
        id: productMatch.match.id,
        name: productMatch.match.name,
      },
    },
  };
}

export function resolveStockAdjustmentRequest(
  text: string,
  parsed: AssistantTaskModelResponse,
  products: { id: string; name: string; sku?: string | null }[]
) {
  const fallbackAdjustment = extractStockAdjustmentFromRequest(text);
  const mode =
    normalizeStockAdjustmentMode(parsed.stockAdjustment?.mode) ||
    fallbackAdjustment.mode ||
    "";
  const quantity = Number(
    normalizePositiveIntegerString(parsed.stockAdjustment?.quantity) ||
      fallbackAdjustment.quantity ||
      ""
  );
  const matchedProductId = normalizeActionText(parsed.matchedProductId);
  const parsedProductName = chooseLongerText(
    cleanupProductName(normalizeActionText(parsed.product?.name)),
    fallbackAdjustment.productName || ""
  );

  if (!mode) {
    return { clarification: stockAdjustmentClarification("missing_mode") };
  }
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { clarification: stockAdjustmentClarification("missing_quantity") };
  }

  const matchedProduct =
    matchedProductId ? products.find((product) => product.id === matchedProductId) ?? null : null;

  if (matchedProduct) {
    return {
      action: {
        type: "adjust_stock" as const,
        product: {
          id: matchedProduct.id,
          name: matchedProduct.name,
        },
        mode,
        quantity,
      },
    };
  }

  if (!parsedProductName) {
    return { clarification: stockAdjustmentClarification("missing_product") };
  }

  const productMatch = findBestProductMatch(parsedProductName, products);
  if (productMatch.ambiguous) {
    return { clarification: stockAdjustmentClarification("ambiguous_product") };
  }

  if (!productMatch.match) {
    return { clarification: stockAdjustmentClarification("missing_product") };
  }

  return {
    action: {
      type: "adjust_stock" as const,
      product: {
        id: productMatch.match.id,
        name: productMatch.match.name,
      },
      mode,
      quantity,
    },
  };
}

export type { ProductInfoEntry };
