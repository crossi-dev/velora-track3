import { NextResponse } from "next/server";
import { resolveProductDeleteRequest } from "../handlers/inventory";
import { matchProductByName } from "../match-product-by-name";
import type { IntentHandler } from "./types";

// Handles `delete_product`: single-product deletion via the regex extractor
// in `resolveProductDeleteRequest`, or multi-product deletion when the model
// returned a `productDeletes` array. Both paths emit a confirmation card —
// destructive op, never executes without an explicit user tap. The single
// path produces a `delete_product` action; the multi path produces a
// `multi_delete_product` action that loops through the IDs in the confirm
// hook on confirm.

export const handleDeleteProduct: IntentHandler = ({ text, safeIntent, parsed, fullCatalogProducts }) => {
  if (safeIntent !== "delete_product") return null;

  const productDeletes = Array.isArray(parsed.productDeletes) ? parsed.productDeletes : null;

  // Multi-product path: model returned an array.
  if (productDeletes && productDeletes.length > 0) {
    const validDeletes: Array<{ id: string; name: string }> = [];
    for (const del of productDeletes) {
      const name = typeof del.productName === "string" ? del.productName.trim() : "";
      if (!name) continue;
      const match = matchProductByName(name, fullCatalogProducts);
      if (match) validDeletes.push({ id: match.id, name: match.name });
    }
    if (validDeletes.length > 1) {
      const summary = validDeletes.map((p) => `• ${p.name}`).join("\n");
      return NextResponse.json({
        answer: `¿Eliminar ${validDeletes.length} productos?\n${summary}`,
        confirmationRequest: {
          id: crypto.randomUUID(),
          severity: "warning",
          title: "Confirmar eliminación de productos",
          message: `¿Eliminar ${validDeletes.length} productos? Esta acción no se puede deshacer.\n${summary}`,
          confirmLabel: "Eliminar todos",
          cancelLabel: "Cancelar",
          action: { type: "multi_delete_product", products: validDeletes },
        },
      });
    }
    // Exactly one valid match → fall through to single-product flow with the matched product.
    if (validDeletes.length === 1) {
      const single = validDeletes[0];
      return NextResponse.json({
        answer: `¿Eliminar "${single.name}"?`,
        confirmationRequest: {
          id: crypto.randomUUID(),
          severity: "warning",
          title: "Confirmar eliminación",
          message: `¿Eliminar el producto "${single.name}"? Esta acción no se puede deshacer.`,
          confirmLabel: "Eliminar",
          cancelLabel: "Cancelar",
          action: { type: "delete_product", product: single },
        },
      });
    }
    // No valid matches in the array → fall through to text-based extraction below.
  }

  // Single-product path: rely on the existing regex extractor against the original text.
  const deleteResolution = resolveProductDeleteRequest(text, fullCatalogProducts);
  if ("clarification" in deleteResolution) {
    return NextResponse.json(deleteResolution.clarification);
  }
  const action = deleteResolution.action;
  return NextResponse.json({
    answer: `¿Eliminar "${action.product.name}"?`,
    confirmationRequest: {
      id: crypto.randomUUID(),
      severity: "warning",
      title: "Confirmar eliminación",
      message: `¿Eliminar el producto "${action.product.name}"? Esta acción no se puede deshacer.`,
      confirmLabel: "Eliminar",
      cancelLabel: "Cancelar",
      action,
    },
  });
};
