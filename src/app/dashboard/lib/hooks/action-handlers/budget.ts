import { executeDashboardAction } from "../../actions/executeDashboardAction";
import { toErrorMessage } from "../assistant-chat-utils";
import type { ActionHandlerArgs } from "./types";

export async function handleCreateBudget({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const data = await executeDashboardAction("budget.create", {
      customerName: String(action.customerName ?? "Consumidor Final"),
      items: Array.isArray(action.items)
        ? action.items.map((i: Record<string, unknown>) => ({
            productId: typeof i.productId === "string" ? i.productId : null,
            name: String(i.name ?? ""),
            quantity: Number(i.quantity ?? 1),
            unitPrice: typeof i.unitPrice === "number" ? i.unitPrice : 0,
          }))
        : [],
    });
    const budgetNumber = (data as { budget?: { budgetNumber?: string } })?.budget?.budgetNumber;
    const msg = budgetNumber
      ? ctx.t(`Quote ${budgetNumber} created.`, `Presupuesto ${budgetNumber} creado.`)
      : ctx.t("Quote created.", "Presupuesto creado.");
    ctx.setAssistantReply(msg);
    ctx.notifyChatSuccess?.(msg);
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(
      e,
      ctx.t("Could not create the quote.", "No se pudo crear el presupuesto."),
    );
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}
