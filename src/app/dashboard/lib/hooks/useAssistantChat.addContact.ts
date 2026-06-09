"use client";

import type { VeloraSingleCommand } from "../command-parsers/shared";
import { buildAddContactConfirmMessage } from "../command-parsers/add-contact";
import type { CommandLayerDispatchContext } from "./useAssistantChat.dispatchHelpers";
import { emitConfirmationCard, makeConfirmationId } from "./useAssistantChat.dispatchHelpers";
import { tLang } from "../DashboardLangContext";

// Extracted to keep useAssistantChat.commandLayer.ts under the 400-LOC
// ceiling. Unified add_contact handler for customer + supplier — the
// confirmation handler dispatches to customer.create or supplier.create
// based on data.kind.
export async function handleAddContactCommand(
  command: Extract<VeloraSingleCommand, { intent: "add_contact" }>,
  rawTextForParser: string,
  ctx: CommandLayerDispatchContext,
): Promise<boolean> {
  const message = buildAddContactConfirmMessage(command.data);
  return emitConfirmationCard(ctx, rawTextForParser, {
    id: makeConfirmationId(),
    severity: "warning",
    title: command.data.kind === "customer"
      ? tLang("Confirm new customer", "Confirmar nuevo cliente")
      : tLang("Confirm new supplier", "Confirmar nuevo proveedor"),
    message,
    confirmLabel: tLang("Confirm", "Confirmar"),
    cancelLabel: tLang("Cancel", "Cancelar"),
    action: {
      type: "add_contact",
      kind: command.data.kind,
      name: command.data.name,
      phone: command.data.phone,
      email: command.data.email,
      taxId: command.data.taxId,
      contactName: command.data.contactName,
    },
  });
}
