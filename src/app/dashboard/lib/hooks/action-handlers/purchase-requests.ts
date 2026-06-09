import { executeDashboardAction } from "../../actions/executeDashboardAction";
import { buildPurchaseRequestDownloadMessage } from "../../purchase-request-chat";
import { toErrorMessage } from "../assistant-chat-utils";
import type { PurchaseRequestRecord } from "../../types";
import type { ActionHandlerArgs } from "./types";

export async function handleSelectPurchaseRequest({ action, parsed, ctx }: ActionHandlerArgs): Promise<boolean> {
  const request = action.request as PurchaseRequestRecord;
  ctx.setLatestPurchaseRequest(request);
  const rawAnswerStr = typeof parsed.rawAnswer === "string" ? parsed.rawAnswer : undefined;
  const reply = rawAnswerStr ?? ctx.t(`Request ${request.requestNumber} selected.`, `Solicitud ${request.requestNumber} seleccionada.`);
  ctx.setAssistantReply(reply);
  ctx.appendDurableReply(reply);
  ctx.setPurchaseActionNotice(reply);
  return true;
}

export async function handleDownloadPurchaseRequest({ action, parsed, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const request = action.request as { id: string; requestNumber: string };
    ctx.downloadPurchaseRequestPdf(request.id, request.requestNumber);
    const rawAnswerStr = typeof parsed.rawAnswer === "string" ? parsed.rawAnswer : undefined;
    const reply = rawAnswerStr ?? buildPurchaseRequestDownloadMessage(request.requestNumber);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    ctx.setPurchaseActionNotice(reply);
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not download the request.", "No se pudo descargar la solicitud."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleSendPurchaseRequestWhatsapp({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const req = action.request as PurchaseRequestRecord;
    ctx.setLatestPurchaseRequest(req);
    const reply = await sendPurchaseRequestToSupplier(req, ctx);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not send the purchase request.", "No se pudo enviar la solicitud de compra."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function handleCreatePurchaseRequest({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const data = await executeDashboardAction("purchase-request.create", {
      supplierName: action.supplierName as string | null,
      itemName: String(action.itemName ?? ""),
      // null means owner did not specify; default to 1 so the server-side
      // normalizePurchaseRequestCreateInput guard always receives a valid value.
      quantity: action.quantity != null ? Number(action.quantity) : 1,
      unitPrice: typeof action.unitPrice === "number" ? action.unitPrice : null,
    });
    const msg = ctx.t(`Done, I created order #${data.requestNumber}.`, `Listo, armé el pedido #${data.requestNumber}.`);
    ctx.setAssistantReply(msg);
    ctx.notifyChatSuccess?.(msg);
    ctx.setLatestPurchaseRequest({
      id: data.id,
      requestNumber: data.requestNumber,
      issuedAt: new Date().toISOString(),
      currency: "ARS",
      totalAmount: 0,
      payload: null,
    });
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not create the purchase request.", "No se pudo crear la solicitud de compra."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}

export async function sendPurchaseRequestToSupplier(
  request: PurchaseRequestRecord | null | undefined,
  ctx: Pick<ActionHandlerArgs["ctx"], "setPurchaseActionNotice" | "appendChatHistoryEntry" | "appendDurableReply" | "t">
): Promise<string> {
  if (!request) {
    const errMsg = ctx.t("No purchase request is selected.", "No hay una solicitud de compra seleccionada.");
    ctx.setPurchaseActionNotice(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
    return errMsg;
  }
  ctx.setPurchaseActionNotice(null);
  try {
    const data = await executeDashboardAction("purchase-request.send-whatsapp", { requestId: request.id });
    const sentMsg = data?.sentTo
      ? ctx.t(`Request sent to ${data.sentTo}.`, `Solicitud enviada a ${data.sentTo}.`)
      : ctx.t("Request sent.", "Solicitud enviada.");
    ctx.setPurchaseActionNotice(sentMsg);
    return sentMsg;
  } catch (err) {
    const errMsg = toErrorMessage(err, ctx.t("Could not open WhatsApp.", "No pude abrir WhatsApp."));
    ctx.setPurchaseActionNotice(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
    return errMsg;
  }
}
