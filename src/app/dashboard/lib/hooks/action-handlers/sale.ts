import { toErrorMessage } from "../assistant-chat-utils";
import type { ActionHandlerArgs } from "./types";

export async function handleRegisterSale({ action, parsed, rawInput, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    ctx.setSaleDraftInput(rawInput);

    // If the server pre-resolved the sale draft in the first model call
    // (via sale-extractor), use it directly and skip the second
    // /api/parse-sale roundtrip. Falls through to parse-sale when the
    // server couldn't resolve (missing prices, unknown products, etc.).
    const preResolved = parsed.saleDraft;
    // Wire qty + unitPrice from the Ventas Agent OA path (CompoundAction.register_sale).
    // When the owner says "vendí 3 alfajores a 1500", the Ventas Agent emits
    // qty=3, unitPrice=1500 on the action. We pass unitPrice as a priceOverride
    // keyed by matchedProductId so parse-sale honours the custom price, and
    // prepend "x<qty>" to raw input so the NLU model parses the correct quantity.
    const actionUnitPrice = typeof action.unitPrice === "number" ? (action.unitPrice as number) : undefined;
    const actionQty = typeof action.qty === "number" && (action.qty as number) > 0 ? (action.qty as number) : undefined;
    const matchedProductIdStr = (action.matchedProductId as string | null) ?? null;
    const priceOverrides = actionUnitPrice !== undefined && matchedProductIdStr
      ? { [matchedProductIdStr]: actionUnitPrice }
      : undefined;
    const rawInputWithQty = actionQty !== undefined ? `x${actionQty} ${rawInput}` : rawInput;
    const parsedResult = preResolved
      ? preResolved
      : await ctx.callParseSale(rawInputWithQty, {
          matchedProductId: matchedProductIdStr,
          matchedCustomerId: (action.matchedCustomerId as string) ?? null,
        }, priceOverrides);

    if (parsedResult) {
      if (action.autoSend) {
        await ctx.dispatchSaleAction("sale.draft.cancel", { emitChatMessage: false });
        await ctx.dispatchSaleAction("sale.confirm-and-send-whatsapp", { draftOverride: parsedResult });
      } else {
        await ctx.dispatchSaleAction("sale.draft.open", { draft: parsedResult, source: "assistant" });
        ctx.appendTransientReply(ctx.t("Sale detected. Review the draft and confirm.", "Venta detectada. Revisá el borrador y confirmá."));
      }
    } else {
      const errMsg = ctx.t("Could not build the sale draft. Try again with more detail.", "No pude armar el borrador de venta. Probá de nuevo con más detalle.");
      ctx.setAssistantReply(errMsg);
      ctx.appendChatHistoryEntry("error", errMsg);
    }
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not register the sale.", "No se pudo registrar la venta."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleSelectCustomer({ action, parsed, ctx }: ActionHandlerArgs): Promise<boolean> {
  const msg = ctx.t("Which of these customers was the sale for?", "¿A cuál de estos clientes se realizó la venta?");
  ctx.activatePendingSaleClarification({
    saleText: action.saleText as string,
    missingField: "customer",
    answer: msg,
    inputHint: parsed.questionInputHint ?? ctx.t("Customer name", "Nombre del cliente"),
    customerOptions: action.clients as Array<{ id: string; name: string }>,
  });
  if (parsed.questionInputHint) ctx.setAssistantInputHint(parsed.questionInputHint);
  ctx.setAssistantReply(msg);
  ctx.appendTransientReply(msg);
  ctx.setCustomerSelectContext({
    saleText: action.saleText as string,
    clients: action.clients as Array<{ id: string; name: string }>,
  });
  return true;
}
