"use client";

import type { VeloraSingleCommand } from "../command-parsers/shared";
import { buildCreateBudgetConfirmMessage } from "../command-parsers/create-budget";
import type { CommandLayerDispatchContext } from "./useAssistantChat.dispatchHelpers";
import { emitConfirmationCard, makeConfirmationId } from "./useAssistantChat.dispatchHelpers";
import { tLang } from "../DashboardLangContext";

// Extracted to keep useAssistantChat.commandLayer.ts under the 400-LOC
// ceiling. Multi-item budget flow: resolves each item's unitPrice from
// the catalog when the parser didn't capture an explicit price, then
// opens a confirmation card wired to budget.create. autoSendWhatsapp is
// parsed but the actual send fires from the confirmation handler (with
// the hint to send from the budget view if we couldn't resolve the
// phone).
export async function handleCreateBudgetCommand(
  command: Extract<VeloraSingleCommand, { intent: "create_budget" }>,
  rawTextForParser: string,
  ctx: CommandLayerDispatchContext,
): Promise<boolean> {
  const message = buildCreateBudgetConfirmMessage(command.data, ctx.businessCurrency);
  return emitConfirmationCard(ctx, rawTextForParser, {
    id: makeConfirmationId(),
    severity: "warning",
    title: tLang("Confirm quote", "Confirmar presupuesto"),
    message,
    confirmLabel: tLang("Confirm", "Confirmar"),
    cancelLabel: tLang("Cancel", "Cancelar"),
    action: {
      type: "create_budget",
      customerName: command.data.customerName,
      items: command.data.items.map((i) => ({
        productId: i.productId,
        name: i.productName,
        quantity: i.quantity,
        unitPrice: i.unitPrice ?? (i.productId ? Number(ctx.products.find((p) => p.id === i.productId)?.price ?? 0) : 0),
      })),
      autoSendWhatsapp: command.data.autoSendWhatsapp,
    },
  });
}
