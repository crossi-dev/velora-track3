import { NextResponse } from "next/server";
import { normalizeActionText, normalizeNonNegativeNumberString, normalizePositiveIntegerString } from "../shared";
import { buildConfirmationRequest } from "../confirmation";
import type { IntentHandler } from "./types";

// Deterministic confirmation prompt for create_purchase_request success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, armé el pedido" before the user confirms the modal.
function buildCreatePurchaseRequestConfirmPrompt(
  itemName: string,
  quantity: number | null,
  unitPrice: number | null,
  supplierName: string,
): string {
  const qtyLabel = quantity != null ? `${quantity} × ` : "";
  const priceLabel = unitPrice ? ` a $${unitPrice}` : "";
  const supplierLabel = supplierName ? ` a ${supplierName}` : "";
  return `Te paso a confirmar el pedido de ${qtyLabel}${itemName}${priceLabel}${supplierLabel}.`;
}

export const handleCreatePurchaseRequest: IntentHandler = ({ safeIntent, parsed }) => {
  if (safeIntent !== "create_purchase_request") return null;

  const draft = parsed.purchaseRequestDraft;
  const supplierName = normalizeActionText(draft?.supplierName) ?? "";
  const items = Array.isArray(draft?.items) ? draft.items : [];
  const first = items[0];
  const itemName = normalizeActionText(first?.itemName) ?? "";
  const qtyStr = normalizePositiveIntegerString(first?.quantity);
  // null means the owner did not specify a quantity — preserve that state
  // rather than defaulting to 0 (which would be semantically "zero units").
  const quantity: number | null = qtyStr ? Number(qtyStr) : null;
  const unitPrice = first?.unitPrice != null
    ? Number(normalizeNonNegativeNumberString(first.unitPrice) ?? "0") || null
    : null;

  if (!itemName) {
    return NextResponse.json({ answer: "¿Qué ítem querés pedir? Ej: 50 kilos de harina." });
  }

  const qtyLabel = quantity != null ? `${quantity} × ` : "sin cantidad × ";
  const priceLabel = unitPrice ? ` a $${unitPrice}` : "";
  const supplierLabel = supplierName ? ` a ${supplierName}` : "";
  const msg = `¿Armamos un pedido de ${qtyLabel}${itemName}${priceLabel}${supplierLabel}?`;

  return NextResponse.json({
    answer: buildCreatePurchaseRequestConfirmPrompt(itemName, quantity, unitPrice, supplierName),
    confirmationRequest: buildConfirmationRequest({
      severity: "warning",
      title: "Confirmar pedido de compra",
      message: msg,
      action: {
        type: "create_purchase_request",
        supplierName: supplierName || null,
        itemName,
        quantity,
        unitPrice,
      },
    }),
  });
};
