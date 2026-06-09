import type { ActionHandlerArgs } from "./types";
import { tLang } from "../../DashboardLangContext";

export async function handleUndo({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  const undoTarget = String(action.undoTarget ?? "sale") as "sale" | "customer" | "stock";
  const undoCount = Number(action.undoCount ?? 1);
  const targetLabels: Record<string, { singular: string; plural: string }> = {
    sale: { singular: tLang("sale", "venta"), plural: tLang("sales", "ventas") },
    customer: { singular: tLang("customer", "cliente"), plural: tLang("customers", "clientes") },
    stock: { singular: tLang("stock load", "carga de stock"), plural: tLang("stock loads", "cargas de stock") },
  };
  const label = targetLabels[undoTarget] ?? { singular: undoTarget, plural: undoTarget };
  const targetText = undoCount === 1
    ? tLang(`the last ${label.singular}`, `la última ${label.singular}`)
    : tLang(`the last ${undoCount} ${label.plural}`, `las últimas ${undoCount} ${label.plural}`);
  const message = tLang(
    `You're about to delete ${targetText}. This cannot be undone.`,
    `Vas a eliminar ${targetText}. Esta acción no se puede deshacer.`
  );
  ctx.setAssistantReply(message);
  ctx.setAssistantConfirmationRequest({
    id: crypto.randomUUID(),
    severity: "critical",
    title: tLang("Confirm deletion", "Confirmar eliminación"),
    message,
    confirmLabel: tLang("Confirm", "Confirmar"),
    cancelLabel: tLang("Cancel", "Cancelar"),
    action: { type: "undo", undoTarget, undoCount },
  });
  return true;
}
