import { NextResponse } from "next/server";
import {
  resolveStockAdjustmentRequest,
  stockLoadClarification,
} from "../handlers/inventory";
import {
  normalizeActionText,
  normalizeNonNegativeNumberString,
  normalizePositiveIntegerString,
} from "../shared";
import { buildConfirmationRequest } from "../confirmation";
import type { IntentHandler } from "./types";

// Deterministic confirmation prompt for stock_load success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, cargué el stock" before the user confirms the modal.
function buildStockLoadConfirmPrompt(
  items: Array<{ itemName: string; quantity: string }>,
  supplierName: string,
): string {
  const itemsText = items
    .filter((it) => it.itemName)
    .map((it) => (it.quantity ? `${it.quantity} ${it.itemName}` : it.itemName))
    .join(", ");
  const supplierSuffix = supplierName ? ` de ${supplierName}` : "";
  return `Te paso a confirmar la carga de ${itemsText}${supplierSuffix}.`;
}

// Handles `stock_load`: assembles draft items (single or multi) and emits
// clarifications when item name / quantity are missing.

export const handleStockLoad: IntentHandler = ({ safeIntent, parsed }) => {
  if (safeIntent !== "stock_load") return null;

  const supplierName = normalizeActionText(parsed.stockDraft?.supplierName) || "";
  const rawItems: Array<{ itemName: string; quantity: string; unitPrice: string }> = [];

  if (Array.isArray(parsed.stockDrafts) && parsed.stockDrafts.length > 0) {
    for (const d of parsed.stockDrafts) {
      rawItems.push({
        itemName: normalizeActionText(d.itemName) ?? "",
        quantity: normalizePositiveIntegerString(d.quantity) ?? "",
        unitPrice: normalizeNonNegativeNumberString(d.unitPrice) ?? "",
      });
    }
  } else {
    rawItems.push({
      itemName: normalizeActionText(parsed.stockDraft?.itemName) ?? "",
      quantity: normalizePositiveIntegerString(parsed.stockDraft?.quantity) ?? "",
      unitPrice: normalizeNonNegativeNumberString(parsed.stockDraft?.unitPrice) ?? "",
    });
  }

  const firstItem = rawItems[0];
  if (!firstItem?.itemName) {
    return NextResponse.json(stockLoadClarification("missing_item"));
  }
  if (!firstItem?.quantity) {
    return NextResponse.json(stockLoadClarification("missing_quantity"));
  }
  return {
    answer: buildStockLoadConfirmPrompt(rawItems, supplierName),
    primaryAction: { type: "stock_load", draft: { items: rawItems, supplierName } },
  };
};

// Deterministic confirmation prompt for adjust_stock success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, ajusté el stock" before the user confirms the modal.
function buildAdjustStockConfirmPrompt(
  productName: string,
  mode: string,
  quantity: number,
): string {
  const unitLabel = quantity === 1 ? "unidad" : "unidades";
  if (mode === "set") {
    return `Te paso a confirmar el ajuste: dejar el stock de ${productName} en ${quantity} ${unitLabel}.`;
  }
  if (mode === "increase") {
    return `Te paso a confirmar el ajuste: sumar ${quantity} ${unitLabel} al stock de ${productName}.`;
  }
  return `Te paso a confirmar el ajuste: restar ${quantity} ${unitLabel} del stock de ${productName}.`;
}

// Handles `adjust_stock`: resolves product match and emits a confirmation
// request describing the set / increase / decrease operation.

export const handleAdjustStock: IntentHandler = ({ text, safeIntent, parsed, fullCatalogProducts, productInfoDirectory }) => {
  if (safeIntent !== "adjust_stock") return null;

  const stockResolution = resolveStockAdjustmentRequest(text, parsed, fullCatalogProducts);
  if ("clarification" in stockResolution) {
    return NextResponse.json(stockResolution.clarification);
  }
  const adj = stockResolution.action as { type: "adjust_stock"; product: { id: string; name: string }; mode: string; quantity: number };

  // Bug 1 guard — refuse decrease that would push stock below zero.
  if (adj.mode === "decrease") {
    const info = productInfoDirectory.find((p) => p.id === adj.product.id);
    const currentStock = info?.stock ?? 0;
    if (adj.quantity > currentStock) {
      const unitLabel = currentStock === 1 ? "unidad" : "unidades";
      return NextResponse.json({
        answer: `Tenés ${currentStock} ${unitLabel} de "${adj.product.name}" en stock, no puedo bajar ${adj.quantity}. ¿Querés que lo deje en 0?`,
      });
    }
  }

  const modeLabel = adj.mode === "set" ? "a" : "en";
  const verbLabel = adj.mode === "set" ? "Establecer" : adj.mode === "increase" ? "Aumentar" : "Reducir";
  const unitLabel = adj.quantity === 1 ? "unidad" : "unidades";
  return NextResponse.json({
    answer: buildAdjustStockConfirmPrompt(adj.product.name, adj.mode, adj.quantity),
    confirmationRequest: buildConfirmationRequest({
      severity: "warning",
      title: "Confirmar ajuste de stock",
      message: `¿${verbLabel} stock de "${adj.product.name}" ${modeLabel} ${adj.quantity} ${unitLabel}?`,
      action: { type: "adjust_stock", product: adj.product, mode: adj.mode as "set" | "increase" | "decrease", quantity: adj.quantity },
    }),
  });
};
