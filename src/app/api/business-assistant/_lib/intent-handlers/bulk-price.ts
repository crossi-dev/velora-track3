import { NextResponse } from "next/server";
import { findProductInfoMatch } from "../handlers/inventory";
import { buildConfirmationRequest } from "../confirmation";
import type { IntentHandler } from "./types";

// Deterministic confirmation prompt for bulk_price_update success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, actualicé los precios" before the user confirms the modal.
function buildBulkPriceUpdateConfirmPrompt(
  direction: "up" | "down" | "set",
  amountLabel: string,
  targetLabel: string,
  productCount: number,
): string {
  const targetText = productCount === 1 ? `"${targetLabel}"` : targetLabel;
  if (direction === "set") {
    return `Te paso a confirmar la actualización: fijar el precio de ${targetText} en ${amountLabel}.`;
  }
  const verb = direction === "up" ? "aumentar" : "reducir";
  return `Te paso a confirmar la actualización: ${verb} ${amountLabel} el precio de ${targetText}.`;
}

// Handles `bulk_price_update`: validates mode/direction/amount, resolves the
// target (all products or a single match), then emits a confirmation request.
// All exits return NextResponse — this intent never produces a primary action
// directly (execution is gated behind user confirmation).

export const handleBulkPriceUpdate: IntentHandler = ({ safeIntent, parsed, fullCatalogProducts, productInfoDirectory }) => {
  if (safeIntent !== "bulk_price_update") return null;

  const bulkUpdate = parsed?.bulkPriceUpdate;
  const rawAmount = Number(bulkUpdate?.amount);
  const mode = bulkUpdate?.mode === "absolute" ? "absolute" : bulkUpdate?.mode === "percentage" ? "percentage" : null;
  if (!mode) {
    return NextResponse.json({ answer: "¿Querés aplicar un porcentaje o un monto fijo?", inputHint: "Ej: 10% o $500" });
  }
  const direction: "up" | "down" | "set" =
    bulkUpdate?.direction === "down"
      ? "down"
      : bulkUpdate?.direction === "set"
        ? "set"
        : "up";
  const target = (bulkUpdate?.target ?? "all").trim().toLowerCase();

  if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
    return NextResponse.json({ answer: "¿Qué monto o porcentaje querés aplicar?" });
  }
  if (mode === "percentage" && rawAmount > 100 && direction === "down") {
    return NextResponse.json({ answer: "No se puede bajar más del 100%." });
  }
  if (direction === "set" && mode !== "absolute") {
    return NextResponse.json({ answer: "Para fijar precios, decime un monto en pesos.", inputHint: "Ej: pone todos los precios a $50" });
  }

  let targetProducts: { id: string; name: string }[];
  let targetLabel: string;

  if (target === "all" || target === "todos" || !target) {
    targetProducts = fullCatalogProducts.map((p) => ({ id: p.id, name: p.name }));
    targetLabel = "todos los productos";
  } else {
    const match = findProductInfoMatch(target, productInfoDirectory);
    if (match.ambiguous) {
      return NextResponse.json({ answer: "Encontré varios productos parecidos. Decime cuál querés actualizar.", inputHint: "Ej: Clavos 2\"" });
    }
    if (!match || !match.match) {
      return NextResponse.json({ answer: `No encontré un producto llamado "${target}". ¿Podés especificar el nombre exacto?` });
    }
    targetProducts = [{ id: match.match.id, name: match.match.name }];
    targetLabel = match.match.name;
  }

  if (targetProducts.length === 0) {
    return NextResponse.json({ answer: "No hay productos en el catálogo para actualizar." });
  }

  const amountLabel = mode === "percentage" ? `${rawAmount}%` : `$${rawAmount}`;
  let message: string;
  if (direction === "set") {
    message = targetProducts.length === 1
      ? `¿Fijar el precio de "${targetLabel}" en ${amountLabel}?`
      : `¿Fijar el precio de ${targetProducts.length} productos en ${amountLabel}?`;
  } else {
    const dirLabel = direction === "up" ? "Aumentar" : "Reducir";
    message = targetProducts.length === 1
      ? `¿${dirLabel} ${amountLabel} el precio de "${targetLabel}"?`
      : `¿${dirLabel} ${amountLabel} los precios de ${targetProducts.length} productos?`;
  }

  return NextResponse.json({
    answer: buildBulkPriceUpdateConfirmPrompt(direction, amountLabel, targetLabel, targetProducts.length),
    confirmationRequest: buildConfirmationRequest({
      severity: "warning",
      title: "Confirmar actualización de precios",
      message,
      action: {
        type: "bulk_price_update",
        amount: rawAmount,
        mode,
        direction,
        productIds: targetProducts.map((p) => p.id),
        targetLabel,
      },
    }),
  });
};
