"use client";

import { buildInvoiceDownloadMessage } from "./invoice-chat";
import { buildPurchaseRequestDownloadMessage } from "./purchase-request-chat";
import { fetchWithTimeout } from "./hooks/utils";
import type { ChatHistoryEntry } from "./types";
import { tLang } from "./DashboardLangContext";

interface UseDashboardDocumentsOptions {
  sendInvoiceByWhatsappBase: (
    invoiceId: string,
    invoiceNumber: string
  ) => Promise<{ successMessage: string }>;
  downloadInvoicePdfBase: (
    invoiceId: string,
    invoiceNumber: string
  ) => Promise<boolean>;
  appendChatHistoryEntry: (
    kind: ChatHistoryEntry["kind"],
    text: string
  ) => void;
  appendDurableChatHistoryEntry: (
    kind: ChatHistoryEntry["kind"],
    text: string
  ) => void;
  setDownloadingPurchaseRequestId: (id: string | null) => void;
  setErrorNotice: (msg: string | null) => void;
}

export function useDashboardDocuments(opts: UseDashboardDocumentsOptions) {
  const {
    sendInvoiceByWhatsappBase,
    downloadInvoicePdfBase,
    appendChatHistoryEntry,
    appendDurableChatHistoryEntry,
    setDownloadingPurchaseRequestId,
    setErrorNotice,
  } = opts;

  async function sendInvoiceByWhatsapp(
    invoiceId: string,
    invoiceNumber: string,
    opts?: { emitChatMessage?: boolean; emitErrorChatMessage?: boolean }
  ) {
    try {
      const data = await sendInvoiceByWhatsappBase(invoiceId, invoiceNumber);
      if (opts?.emitChatMessage) {
        appendDurableChatHistoryEntry("reply", data.successMessage);
      }
      return data;
    } catch (error) {
      if (opts?.emitErrorChatMessage) {
        const errMsg = error instanceof Error ? error.message : tLang("Could not send the invoice via WhatsApp.", "No se pudo enviar la factura por WhatsApp.");
        appendChatHistoryEntry("error", errMsg);
      }
      throw error;
    }
  }

  async function downloadInvoicePdf(
    invoiceId: string,
    invoiceNumber: string,
    opts?: { emitChatMessage?: boolean }
  ) {
    const downloaded = await downloadInvoicePdfBase(invoiceId, invoiceNumber);
    if (downloaded && opts?.emitChatMessage) {
      appendDurableChatHistoryEntry("reply", buildInvoiceDownloadMessage(invoiceNumber));
    } else if (!downloaded && opts?.emitChatMessage) {
      appendChatHistoryEntry("error", tLang("Could not generate the PDF. Try again.", "No se pudo generar el PDF. Intentá de nuevo."));
    }
  }

  async function downloadPurchaseRequestPdf(
    id: string,
    num: string,
    opts?: { emitChatMessage?: boolean }
  ) {
    setDownloadingPurchaseRequestId(id);
    try {
      const res = await fetchWithTimeout(`/api/purchase-requests/${id}/pdf`, {});
      if (!res.ok) throw new Error(tLang("Could not generate the PDF.", "No se pudo generar el PDF."));
      const blob = await res.blob();
      const { downloadPdfBlob } = await import("@/lib/capacitor-helpers");
      const ok = await downloadPdfBlob(blob, `Pedido-${num}.pdf`);
      if (!ok) throw new Error(tLang("Could not download the PDF.", "No se pudo descargar el PDF."));
      if (opts?.emitChatMessage) {
        appendDurableChatHistoryEntry("reply", buildPurchaseRequestDownloadMessage(num));
      }
    } catch {
      setErrorNotice(tLang("Could not generate the purchase order PDF. Try again.", "No se pudo generar el PDF del pedido. Intentá de nuevo."));
      if (opts?.emitChatMessage) {
        appendChatHistoryEntry("error", tLang("Could not generate the purchase order PDF. Try again.", "No se pudo generar el PDF del pedido. Intentá de nuevo."));
      }
    } finally {
      setDownloadingPurchaseRequestId(null);
    }
  }

  return { sendInvoiceByWhatsapp, downloadInvoicePdf, downloadPurchaseRequestPdf };
}
