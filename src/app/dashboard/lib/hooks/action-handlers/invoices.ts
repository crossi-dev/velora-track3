import { buildInvoiceDownloadMessage } from "../../invoice-chat";
import { toErrorMessage } from "../assistant-chat-utils";
import type { ActionHandlerArgs } from "./types";
import type { InvoiceStatus } from "../../types";

export async function handleSelectInvoice({ action, parsed, ctx }: ActionHandlerArgs): Promise<boolean> {
  const invoice = action.invoice as { id: string; invoiceNumber: string };
  ctx.setActiveInvoiceId(invoice.id);
  // Bible §4: facturas viven dentro de Ventas — abrimos el sheet inline en
  // lugar de switchear a la tab legacy.
  ctx.setInvoiceSheetOpen(true);
  const rawAnswerStr = typeof parsed.rawAnswer === "string" ? parsed.rawAnswer : undefined;
  const reply = rawAnswerStr ?? ctx.t(`Invoice ${invoice.invoiceNumber} selected.`, `Factura ${invoice.invoiceNumber} seleccionada.`);
  ctx.setAssistantReply(reply);
  ctx.appendDurableReply(reply);
  ctx.setInvoiceStatusNotice({ tone: "info", message: reply });
  return true;
}

export async function handleUpdateInvoiceStatus({ action, parsed, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const invoice = action.invoice as { id: string; invoiceNumber: string };
    const status = action.status as InvoiceStatus;
    await ctx.updateInvoiceStatus(invoice.id, status);
    const rawAnswerStr = typeof parsed.rawAnswer === "string" ? parsed.rawAnswer : undefined;
    const reply = rawAnswerStr ?? ctx.t(`Invoice ${invoice.invoiceNumber} updated.`, `Factura ${invoice.invoiceNumber} actualizada.`);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    ctx.setInvoiceStatusNotice({ tone: "success", message: reply });
    await ctx.loadBusiness({ silent: true, force: true }).catch(() => {});
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not update the invoice.", "No se pudo actualizar la factura."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
    ctx.setInvoiceStatusNotice({ tone: "error", message: errMsg });
  }
  return true;
}

export async function handleSendInvoiceWhatsapp({ action, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const invoice = action.invoice as { id: string; invoiceNumber: string; customerPhone?: string | null };
    const result = await ctx.sendInvoiceToCustomer(invoice.id, invoice.invoiceNumber, invoice.customerPhone);
    ctx.setAssistantReply(result.message);
    if (result.ok) {
      ctx.appendDurableReply(result.message);
      ctx.setActiveInvoiceId(invoice.id);
    } else {
      ctx.appendChatHistoryEntry("error", result.message);
    }
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not send the invoice.", "No se pudo enviar la factura."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
    ctx.setInvoiceStatusNotice({ tone: "error", message: errMsg });
  }
  return true;
}

export async function handleDownloadInvoice({ action, parsed, ctx }: ActionHandlerArgs): Promise<boolean> {
  try {
    const invoice = action.invoice as { id: string; invoiceNumber: string };
    ctx.downloadInvoicePdf(invoice.id, invoice.invoiceNumber);
    const rawAnswerStr = typeof parsed.rawAnswer === "string" ? parsed.rawAnswer : undefined;
    const reply = rawAnswerStr ?? buildInvoiceDownloadMessage(invoice.invoiceNumber);
    ctx.setAssistantReply(reply);
    ctx.appendDurableReply(reply);
    ctx.setInvoiceStatusNotice({ tone: "info", message: reply });
  } catch (e) {
    const errMsg = toErrorMessage(e, ctx.t("Could not download the invoice.", "No se pudo descargar la factura."));
    ctx.setAssistantReply(errMsg);
    ctx.appendChatHistoryEntry("error", errMsg);
  }
  return true;
}
