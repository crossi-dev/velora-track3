"use client";

import { useState } from "react";
import { fetchWithTimeout } from "./utils";
import { tLang } from "../DashboardLangContext";
import { executeDashboardAction } from "../actions/executeDashboardAction";
import { updateInvoiceStatusAction } from "@/app/actions/mutations";
import type {
  FeedbackNotice,
  InvoicePayload,
} from "../types";

interface useSalesInvoicesOptions {
  businessId: string | null;
  setPageError: (msg: string | null) => void;
  setErrorNotice: (msg: string | null) => void;
  setSuccessNotice: (msg: string | null) => void;
  setDownloadingInvoiceId: (id: string | null) => void;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  markUpdated: (key: string) => void;
}

interface CanonicalInvoiceWhatsappSendInput {
  businessId: string | null;
  invoiceId: string;
  invoiceNumber: string;
  phone?: string | null;
  /**
   * Pre-fetched invoice payload from the sale.create response.
   * When provided, the server skips its DB lookup, eliminating
   * the read-after-write race against Neon's connection pooler.
   */
  payload?: InvoicePayload | null;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  markUpdated?: (key: string) => void;
}

interface CanonicalInvoiceWhatsappSendResult {
  sentTo?: string;
  successMessage: string;
}

export async function runCanonicalInvoiceWhatsappSend(
  input: CanonicalInvoiceWhatsappSendInput
): Promise<CanonicalInvoiceWhatsappSendResult> {
  if (!input.businessId) {
    throw new Error(tLang("Could not send the invoice via WhatsApp. Check the number with country code (e.g. +54911...).", "No se pudo enviar la factura por WhatsApp. Verificá el número con prefijo de país (ej: +54911...)."));
  }

  const data = await executeDashboardAction("invoice.send-whatsapp", {
    invoiceId: input.invoiceId,
    phone: input.phone ?? null,
    payload: input.payload ?? null,
    invoiceNumber: input.invoiceNumber,
  });
  await input.loadBusiness({ silent: true, force: true }).catch(() => {});
  input.markUpdated?.("invoices");

  const label = input.invoiceNumber.trim().toUpperCase().startsWith("FC-")
    ? tLang("Invoice", "Factura")
    : tLang("Receipt", "Comprobante");
  const baseMessage = data?.sentTo
    ? tLang(`${label} ${input.invoiceNumber} sent to ${data.sentTo}.`, `${label} ${input.invoiceNumber} enviada a ${data.sentTo}.`)
    : tLang(`${label} ${input.invoiceNumber} sent via WhatsApp.`, `${label} ${input.invoiceNumber} enviada por WhatsApp.`);
  const noAttachSuffix = tLang(
    " (no PDF attached — there was a problem attaching the file)",
    " (sin PDF adjunto — hubo un problema al adjuntar el archivo)"
  );
  const successMessage = data?.pdfAttached === false
    ? `${baseMessage}${noAttachSuffix}`
    : baseMessage;

  return {
    sentTo: data?.sentTo,
    successMessage,
  };
}

export function useSalesInvoices(opts: useSalesInvoicesOptions) {
  const [activeInvoiceId, setActiveInvoiceId] = useState<string | null>(null);
  const [invoiceStatusNotice, setInvoiceStatusNotice] = useState<FeedbackNotice | null>(null);

  const { businessId, loadBusiness, markUpdated } = opts;

  async function updateInvoiceStatus(invoiceId: string, status: "issued" | "sent" | "paid") {
    if (!businessId) return;
    const result = await updateInvoiceStatusAction(invoiceId, status);
    if (!result.ok) {
      const msg = result.error ?? tLang("Could not update the invoice.", "No se pudo actualizar la factura.");
      opts.setPageError(msg);
      throw new Error(msg);
    }
    await loadBusiness({ silent: true, force: true }).catch(() => {});
    markUpdated("invoices");
  }

  async function sendInvoiceByWhatsapp(invoiceId: string, invoiceNumber: string) {
    return runCanonicalInvoiceWhatsappSend({
      businessId,
      invoiceId,
      invoiceNumber,
      loadBusiness,
      markUpdated,
    });
  }

  async function downloadInvoicePdf(invoiceId: string, invoiceNumber: string) {
    opts.setDownloadingInvoiceId(invoiceId);
    try {
      const res = await fetchWithTimeout(`/api/invoices/${invoiceId}/pdf`, {});
      if (!res.ok) throw new Error(tLang("Could not generate the PDF.", "No se pudo generar el PDF."));
      const blob = await res.blob();
      const { downloadPdfBlob } = await import("@/lib/capacitor-helpers");
      const ok = await downloadPdfBlob(blob, `Factura-${invoiceNumber}.pdf`);
      if (!ok) throw new Error(tLang("Could not download the PDF.", "No se pudo descargar el PDF."));
      return true;
    } catch {
      opts.setErrorNotice(tLang("Could not generate the PDF. Try again.", "No se pudo generar el PDF. Intentá de nuevo."));
      return false;
    } finally {
      opts.setDownloadingInvoiceId(null);
    }
  }

  return {
    activeInvoiceId, setActiveInvoiceId,
    invoiceStatusNotice, setInvoiceStatusNotice,
    updateInvoiceStatus,
    sendInvoiceByWhatsapp,
    downloadInvoicePdf,
  };
}
