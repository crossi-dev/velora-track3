import { NextResponse } from "next/server";
import { normalizeActionText, normalizeNonNegativeNumberString, normalizePositiveIntegerString } from "../shared";
import { buildConfirmationRequest } from "../confirmation";
import { matchProductByName } from "../match-product-by-name";
import type { IntentHandler } from "./types";

// Deterministic confirmation prompt for create_budget success paths.
// Replaces the LLM-generated `answer` to prevent past-tense hallucinations
// like "Listo, generé el presupuesto" before the user confirms the modal.
function buildCreateBudgetConfirmPrompt(
  customerName: string,
  itemCount: number,
  total: number,
): string {
  const fmt = (n: number) => new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(n);
  const itemsLabel = itemCount === 1 ? "1 ítem" : `${itemCount} ítems`;
  return `Te paso a confirmar el presupuesto para ${customerName} con ${itemsLabel} por un total de $${fmt(total)}.`;
}

export const handleCreateBudget: IntentHandler = ({ safeIntent, parsed, fullCatalogProducts }) => {
  if (safeIntent !== "create_budget") return null;

  const draft = parsed.budgetDraft;
  const customerName = normalizeActionText(draft?.customerName) ?? "Consumidor Final";
  const rawItems = Array.isArray(draft?.items) ? draft.items : [];

  if (rawItems.length === 0) {
    return NextResponse.json({ answer: "¿Qué ítems querés incluir en el presupuesto? Decime nombre, cantidad y precio." });
  }

  const items = rawItems
    .map((item) => {
      const name = normalizeActionText(item.name) ?? "";
      if (!name) return null;
      const match = matchProductByName(name, fullCatalogProducts);
      const qty = Number(normalizePositiveIntegerString(item.quantity) ?? "1") || 1;
      const unitPrice = Number(normalizeNonNegativeNumberString(item.unitPrice) ?? "0") || 0;
      return { productId: match?.id ?? null, name: match?.name ?? name, quantity: qty, unitPrice };
    })
    .filter((i): i is NonNullable<typeof i> => i !== null);

  if (items.length === 0) {
    return NextResponse.json({ answer: "No pude identificar los ítems. ¿Podés repetirlos con nombre, cantidad y precio?" });
  }

  const total = items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);
  const fmt = (n: number) => new Intl.NumberFormat("es-AR", { maximumFractionDigits: 0 }).format(n);
  const lines = items.map((i) => `· ${i.quantity}× ${i.name} — $${fmt(i.unitPrice)}`).join("\n");
  const msg = `¿Genero el presupuesto para ${customerName}?\n${lines}\nTotal: $${fmt(total)}`;
  const autoSendWhatsapp = draft?.autoSendWhatsapp === true;

  return NextResponse.json({
    answer: buildCreateBudgetConfirmPrompt(customerName, items.length, total),
    confirmationRequest: buildConfirmationRequest({
      severity: "warning",
      title: "Crear presupuesto",
      message: msg,
      action: { type: "create_budget", customerName, items, autoSendWhatsapp },
    }),
  });
};
