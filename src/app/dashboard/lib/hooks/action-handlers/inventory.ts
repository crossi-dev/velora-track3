import { executeDashboardAction } from "../../actions/executeDashboardAction";
import type { AssistantStockDraft, Product } from "../../types";
import type { AssistantConfirmationRequest } from "../../assistant-action.types";
import type { MovementType } from "../../command-parsers/shared";
import type { ActionHandlerArgs } from "./types";

export async function handleStockLoad({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  const msg = ctx.t("I prepared a stock load. Review the supplier, items, quantities and prices before confirming.", "Preparé una carga de stock. Revisá proveedor, ítems, cantidades y precios antes de confirmarla.");
  ctx.setAssistantReply(msg);
  ctx.appendTransientReply(msg);
  ctx.setAssistantStockDraft(action.draft as AssistantStockDraft);
  return true;
}

export async function handleAdjustStock({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const product = action.product as { id: string; name: string };
    const mode = action.mode as "set" | "increase" | "decrease";
    const quantity = Number(action.quantity ?? 0);
    // id may be "" when not in snapshot — fall back to name lookup
    const resolved = product.id
      ? (ctx.products as Product[]).find((p) => p.id === product.id)
      : (ctx.products as Product[]).find((p) => p.name.toLowerCase() === product.name.toLowerCase());
    if (!resolved) throw new Error(ctx.t(`Could not find product "${product.name}".`, `No encontré el producto "${product.name}".`));
    const currentStock = resolved.stock ?? 0;
    const newStock = mode === "set"
      ? quantity
      : mode === "increase"
        ? currentStock + quantity
        : Math.max(0, currentStock - quantity);
    await executeDashboardAction("stock.adjust", { id: resolved.id, stock: newStock, stockReason: "assistant_adjustment" });
    const reply = ctx.t(`Done, I updated the stock for "${resolved.name}".`, `Listo, actualicé el stock de "${resolved.name}".`);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const detail = e instanceof Error ? ` (${e.message})` : "";
    const errMsg = ctx.t(`Could not adjust the stock. Check the product and try again.${detail}`, `No pude ajustar el stock. Revisá el producto e intentá de nuevo.${detail}`);
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

const VALID_MOVEMENT_TYPES = new Set<MovementType>(["purchase", "tax", "salary", "adjustment", "income", "withdrawal"]);

const MOVEMENT_TYPE_LABEL: Record<MovementType, string> = {
  purchase: "compra", tax: "impuesto", salary: "sueldo", adjustment: "ajuste", income: "ingreso",
  // "withdrawal" = sangría / retiro de efectivo de caja. Added 2026-06-03.
  withdrawal: "retiro / sangría",
};

// OA path: Ventas agent emits register_movement as a CompoundAction.
// Mirror the employee server-side intent-handler (movement.ts) by showing a
// confirmation card before committing to the ledger — a misheard amount must
// not hit cash-movement.create without user review.
export async function handleRegisterMovement({ action, parsed, ctx }: ActionHandlerArgs): Promise<boolean> {
  const movement = action.movement as { movementType?: string; amount?: number; description?: string } | undefined;
  if (!movement?.movementType || typeof movement?.amount !== "number") {
    const rawAnswerStr = typeof parsed.rawAnswer === "string" ? parsed.rawAnswer : undefined;
    const clarifyReply = rawAnswerStr ?? ctx.t("I need more data to register the movement.", "Necesito más datos para registrar el movimiento.");
    ctx.setAssistantReply(clarifyReply);
    ctx.appendDurableReply(clarifyReply);
    return true;
  }

  const movementType = movement.movementType as MovementType;
  if (!VALID_MOVEMENT_TYPES.has(movementType)) {
    const errMsg = ctx.t("Could not register that movement. If you want, we can retry with complete data.", "No pude registrar ese movimiento. Si querés, lo reintentamos con los datos completos.");
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
    return true;
  }

  const amount = movement.amount;
  const description = movement.description ?? "";
  const typeLabel = MOVEMENT_TYPE_LABEL[movementType];
  const amountLabel = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(amount);
  const confirmMsg = ctx.t(
    `Confirm ${typeLabel} of ${amountLabel}${description ? ` — ${description}` : ""}?`,
    `¿Confirmar ${typeLabel} por ${amountLabel}${description ? ` — ${description}` : ""}?`,
  );
  const cardId = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `m_${Date.now()}`;
  const confirmationRequest: AssistantConfirmationRequest = {
    id: cardId,
    severity: "warning",
    title: ctx.t("Confirm movement", "Confirmar movimiento"),
    message: confirmMsg,
    confirmLabel: ctx.t("Confirm", "Confirmar"),
    cancelLabel: ctx.t("Cancel", "Cancelar"),
    action: { type: "register_movement", movement: { movementType, amount, description } },
  };
  const prompt = ctx.t(
    `I'll register a ${typeLabel} of ${amountLabel}${description ? ` (${description})` : ""}. Confirm?`,
    `Te paso a confirmar el registro de ${typeLabel} por ${amountLabel}${description ? ` (${description})` : ""}.`,
  );
  ctx.setAssistantReply(prompt);
  ctx.appendTransientReply(prompt);
  ctx.setAssistantConfirmationRequest(confirmationRequest);
  return true;
}
