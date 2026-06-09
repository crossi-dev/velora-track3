"use client";

import { useState } from "react";
import { CaretLeftIcon } from "@phosphor-icons/react";
import type { InvoiceStatus } from "@/domain";
import type { InvoiceRecord, InvoicePayload, BusinessSummary, ChatHistoryEntry, FeedbackNotice } from "../lib/types";
import { Button } from "@/components/ui/button";
import { InlineNotice } from "./InlineNotice";
import { STATUS_NEXT } from "./InvoiceStatusPills";
import { navigateFromUserAction } from "../lib/navigate";
import { canSendInvoiceByWhatsapp } from "../lib/whatsapp-visibility";
import { InvoiceHeader, InvoiceParties, InvoiceItemsTable, InvoiceStatusBar, InvoiceActions, FONT_DM } from "./InvoiceDetailParts";

interface InvoiceDetailProps {
  business: BusinessSummary;
  selectedInvoice: InvoiceRecord;
  selectedInvoiceBusiness: InvoicePayload["business"] | undefined;
  selectedInvoiceCustomer: InvoicePayload["customer"] | undefined;
  selectedInvoiceSale: InvoicePayload["sale"] | undefined;
  invoiceStatusNotice: FeedbackNotice | null;
  setInvoiceStatusNotice: (value: FeedbackNotice | null) => void;
  downloadingInvoiceId: string | null;
  downloadInvoicePdf: (invoiceId: string, invoiceNumber: string) => void;
  sendInvoiceByWhatsapp: (
    invoiceId: string,
    invoiceNumber: string,
    opts?: { emitChatMessage?: boolean; emitErrorChatMessage?: boolean }
  ) => Promise<{ sentTo?: string; successMessage: string }>;
  updateInvoiceStatus: (invoiceId: string, status: InvoiceStatus) => Promise<void>;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
  onBackToList: () => void;
  moneyFmt: (value: unknown, currency: string) => string;
  formatDate: (value: string) => string;
  t: (en: string, es: string) => string;
}

export function InvoiceDetail({
  business, selectedInvoice, selectedInvoiceBusiness, selectedInvoiceCustomer,
  selectedInvoiceSale, invoiceStatusNotice, setInvoiceStatusNotice,
  downloadingInvoiceId, downloadInvoicePdf, sendInvoiceByWhatsapp,
  updateInvoiceStatus, appendChatHistoryEntry, onBackToList, moneyFmt, formatDate, t,
}: InvoiceDetailProps) {
  const [pendingStatusChange, setPendingStatusChange] = useState<InvoiceStatus | null>(null);
  const [pendingInvoiceAction, setPendingInvoiceAction] = useState<string | null>(null);
  const [whatsAppFailed, setWhatsAppFailed] = useState(false);

  const hasPhone = canSendInvoiceByWhatsapp(selectedInvoice.payload?.customer.phone);

  async function handleStatusChange(invoice: InvoiceRecord, status: InvoiceStatus) {
    setPendingInvoiceAction(invoice.id);
    try {
      await updateInvoiceStatus(invoice.id, status);
      const successMsg = status === "sent"
        ? t(`Done, marked invoice as sent.\n${invoice.invoiceNumber}`, `Listo, marqué la factura como enviada.\n${invoice.invoiceNumber}`)
        : t(`Done, marked invoice as paid.\n${invoice.invoiceNumber}`, `Listo, marqué la factura como cobrada.\n${invoice.invoiceNumber}`);
      setInvoiceStatusNotice({ tone: "success", message: successMsg });
      appendChatHistoryEntry("success", successMsg);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : t("Could not update the invoice.", "No se pudo actualizar la factura.");
      setInvoiceStatusNotice({ tone: "error", message: errMsg });
      appendChatHistoryEntry("error", errMsg);
    } finally {
      setPendingInvoiceAction(null);
      setPendingStatusChange(null);
    }
  }

  function cancelPendingStatusChange() {
    if (!pendingStatusChange) return;
    appendChatHistoryEntry("reply", t("Done, no changes applied.", "Listo, no apliqué cambios."));
    setPendingStatusChange(null);
  }

  async function sendByWhatsApp(invoice: InvoiceRecord) {
    setInvoiceStatusNotice(null);
    setWhatsAppFailed(false);
    setPendingInvoiceAction(invoice.id);
    try {
      const data = await sendInvoiceByWhatsapp(invoice.id, invoice.invoiceNumber, { emitChatMessage: true, emitErrorChatMessage: false });
      setInvoiceStatusNotice({ tone: "success", message: data.successMessage });
    } catch (error) {
      const phone = (invoice.payload?.customer.phone ?? "").replace(/\D/g, "");
      if (phone) {
        const fallbackMessage = t(`Hi, sharing invoice ${invoice.invoiceNumber}.`, `Hola, te comparto la factura ${invoice.invoiceNumber}.`);
        if (navigateFromUserAction(`https://wa.me/${phone}?text=${encodeURIComponent(fallbackMessage)}`)) {
          const handoffNotice = t("Done, opening WhatsApp...", "Listo, abriendo WhatsApp...");
          setInvoiceStatusNotice({ tone: "info", message: handoffNotice });
          appendChatHistoryEntry("reply", handoffNotice);
          return;
        }
      }
      const errMsg = error instanceof Error ? error.message : t("Could not send the invoice via WhatsApp.", "No se pudo enviar la factura por WhatsApp.");
      setWhatsAppFailed(true);
      setInvoiceStatusNotice({ tone: "error", message: errMsg });
      appendChatHistoryEntry("error", errMsg);
    } finally {
      setPendingInvoiceAction(null);
    }
  }

  if (!selectedInvoice.payload) {
    return <p style={{ fontFamily: FONT_DM, color: "var(--tone-muted)" }}>{t("Invoice details not available.", "Detalle de factura no disponible.")}</p>;
  }

  const status = selectedInvoice.status ?? "issued";
  const documentType = selectedInvoice.documentType ?? "receipt";
  const currency = selectedInvoiceBusiness?.currency ?? selectedInvoice.currency;
  const totalFormatted = moneyFmt(selectedInvoiceSale?.total, currency);
  const currencyMatch = totalFormatted.match(/^([A-Z]+\s*)?(.+)$/);
  const currencyPrefix = (currencyMatch?.[1] ?? "$").trim();
  const totalAmount = currencyMatch?.[2] ?? totalFormatted;

  const nextStatus = STATUS_NEXT[status];
  const cycleStatusHandler = () => { if (nextStatus !== status) setPendingStatusChange(nextStatus); };
  const markSentHandler = status === "issued" ? () => setPendingStatusChange("sent") : null;

  return (
    <div>
      <Button type="button" variant="outline" onClick={onBackToList} className="xl:hidden mb-4 gap-1.5 px-3 py-2 text-sm">
        <CaretLeftIcon aria-hidden />
        {t("Back", "Volver")}
      </Button>

      <InvoiceHeader
        invoiceNumber={selectedInvoiceSale?.invoiceNumber ?? selectedInvoice.invoiceNumber}
        documentType={documentType} status={status}
        date={selectedInvoiceSale?.date ?? selectedInvoice.issuedAt}
        total={totalAmount} currencyPrefix={currencyPrefix === "$" ? "$" : `${currencyPrefix} `}
        onChangeStatus={cycleStatusHandler} formatDate={formatDate} t={t}
      />

      {pendingStatusChange && (
        <InvoiceStatusBar
          pendingStatus={pendingStatusChange}
          onConfirm={() => void handleStatusChange(selectedInvoice, pendingStatusChange)}
          onCancel={cancelPendingStatusChange}
          isPending={pendingInvoiceAction === selectedInvoice.id}
          t={t}
        />
      )}

      <InvoiceParties business={business} invoiceBusiness={selectedInvoiceBusiness} customer={selectedInvoiceCustomer} t={t} />
      <InvoiceItemsTable items={selectedInvoiceSale?.items ?? []} currency={currency} moneyFmt={moneyFmt} t={t} />
      <InvoiceActions
        status={status} hasPhone={hasPhone}
        isDownloading={downloadingInvoiceId === selectedInvoice.id}
        isPendingAction={pendingInvoiceAction === selectedInvoice.id}
        onMarkSent={markSentHandler}
        onDownload={() => void downloadInvoicePdf(selectedInvoice.id, selectedInvoice.invoiceNumber)}
        onWhatsApp={() => void sendByWhatsApp(selectedInvoice)}
        t={t}
      />

      {invoiceStatusNotice && (
        <div className="mt-3">
          <InlineNotice message={invoiceStatusNotice.message} tone={invoiceStatusNotice.tone} />
          {whatsAppFailed && invoiceStatusNotice.tone === "error" && (
            <Button type="button" variant="outline" onClick={() => { setWhatsAppFailed(false); void sendByWhatsApp(selectedInvoice); }} disabled={pendingInvoiceAction === selectedInvoice.id} className="mt-2 px-4 py-2 text-sm w-full sm:w-auto">
              {t("Retry send", "Reintentar envío")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
