import { NextResponse } from "next/server";
import { normalizeActionText, normalizeNonNegativeNumberString, normalizePositiveIntegerString } from "../shared";
import { buildConfirmationRequest } from "../confirmation";
import type { IntentHandler } from "./types";

// Deterministic confirmation prompt for create_product success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, creé el producto" before the user confirms the modal.
function buildCreateProductConfirmPrompt(
  name: string,
  price: number,
  stock: number,
): string {
  const stockSuffix = stock > 0 ? ` con ${stock} unidades de stock inicial` : "";
  return `Te paso a confirmar el alta del producto "${name}" a $${price}${stockSuffix}.`;
}

export const handleCreateProduct: IntentHandler = ({ safeIntent, parsed }) => {
  if (safeIntent !== "create_product") return null;

  const draft = parsed.productDraft;
  const name = normalizeActionText(draft?.name) ?? "";
  const priceRaw = normalizeNonNegativeNumberString(draft?.price);
  const price = priceRaw ? Number(priceRaw) : 0;
  const stockRaw = normalizePositiveIntegerString(draft?.stock);
  const stock = stockRaw ? Number(stockRaw) : 0;

  if (!name) {
    return NextResponse.json({ answer: "¿Cómo se llama el producto que querés crear?" });
  }
  if (!price || !Number.isFinite(price) || price <= 0) {
    return NextResponse.json({ answer: `¿A qué precio vendés "${name}"?` });
  }

  const stockLabel = stock > 0 ? ` con ${stock} unidades de stock inicial` : "";
  const msg = `¿Creo el producto "${name}" a $${price}${stockLabel}?`;

  return NextResponse.json({
    answer: buildCreateProductConfirmPrompt(name, price, stock),
    confirmationRequest: buildConfirmationRequest({
      severity: "warning",
      title: "Crear producto",
      message: msg,
      action: { type: "create_product", product: { name, price, stock } },
    }),
  });
};
