import { NextResponse } from "next/server";
import { resolveProductEditRequest } from "../handlers/inventory";
import { matchProductByName } from "../match-product-by-name";
import type { CompoundAction, IntentHandler } from "./types";

// Deterministic confirmation prompt for edit_product success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, actualicé el precio" before the user confirms the modal.
function buildEditProductConfirmPrompt(
  productName: string,
  field: string,
  value: string | number,
): string {
  const fieldLabel =
    field === "price"
      ? "el precio"
      : field === "stock"
      ? "el stock"
      : field === "name"
      ? "el nombre"
      : `el campo ${field}`;
  const valueText = typeof value === "number" ? `$${value}` : String(value);
  return `Te paso a confirmar la actualización: ${fieldLabel} de ${productName} a ${valueText}.`;
}

// Handles `edit_product`: supports both single-field edits (via
// `resolveProductEditRequest`) and multi-product price edits when the model
// returned a `productEdits` array. Multi-edits go through a confirmation
// request that emits a `multi_edit_product` action on confirm.

export const handleEditProduct: IntentHandler = ({ text, safeIntent, parsed, fullCatalogProducts }) => {
  if (safeIntent !== "edit_product") return null;

  const productEdits = Array.isArray(parsed.productEdits) ? parsed.productEdits : null;
  if (productEdits && productEdits.length > 1) {
    const validEdits: Array<{ productName: string; field: string; value: number }> = [];
    for (const edit of productEdits) {
      const name = typeof edit.productName === "string" ? edit.productName.trim() : "";
      const value = Number(edit.value);
      if (!name || !Number.isFinite(value) || value < 0) continue;
      const match = matchProductByName(name, fullCatalogProducts);
      if (match) {
        validEdits.push({ productName: match.name, field: edit.field || "price", value });
      }
    }
    if (validEdits.length > 0) {
      const summary = validEdits.map((e) => `${e.productName} → $${e.value}`).join("\n");
      return NextResponse.json({
        answer: `¿Actualizar ${validEdits.length} precio${validEdits.length > 1 ? "s" : ""}?\n${summary}`,
        confirmationRequest: {
          id: crypto.randomUUID(),
          severity: "warning",
          title: "Confirmar actualización de precios",
          message: `¿Actualizar ${validEdits.length} precio${validEdits.length > 1 ? "s" : ""}?\n${summary}`,
          confirmLabel: "Confirmar",
          cancelLabel: "Cancelar",
          action: { type: "multi_edit_product", edits: validEdits },
        },
      });
    }
  }

  const editResolution = resolveProductEditRequest(text, parsed, fullCatalogProducts);
  if ("clarification" in editResolution) {
    return NextResponse.json(editResolution.clarification);
  }
  const action = editResolution.action as CompoundAction & { product: { name: string }; field: string; value: string | number };
  return {
    answer: buildEditProductConfirmPrompt(action.product.name, action.field, action.value),
    primaryAction: action,
  };
};
