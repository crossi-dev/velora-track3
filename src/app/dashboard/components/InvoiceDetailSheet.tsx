"use client";

import { type CSSProperties } from "react";
import { Printer } from "@phosphor-icons/react";
import type { InvoiceStatus } from "@/domain";
import type { InvoicePayload, InvoiceRecord, BusinessSummary, ChatHistoryEntry, FeedbackNotice } from "../lib/types";
import { InvoiceDetail } from "./InvoiceDetail";
import { isCapacitor } from "@/lib/capacitor-helpers";
import { BottomSheet } from "./BottomSheet";

const PRINT_BTN_STYLE: CSSProperties = {
  marginTop: "16px",
  width: "100%",
  padding: "10px 16px",
  borderRadius: "8px",
  border: "1px solid var(--border)",
  background: "var(--surface-subtle)",
  color: "var(--tone-strong)",
  fontSize: "0.9375rem",
  fontWeight: 500,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "6px",
};

interface InvoiceDetailSheetProps {
  open: boolean;
  business: BusinessSummary;
  selectedInvoice: InvoiceRecord | null;
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
    opts?: { emitChatMessage?: boolean; emitErrorChatMessage?: boolean },
  ) => Promise<{ sentTo?: string; successMessage: string }>;
  updateInvoiceStatus: (invoiceId: string, status: InvoiceStatus) => Promise<void>;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
  onClose: () => void;
  moneyFmt: (value: unknown, currency: string) => string;
  formatDate: (value: string) => string;
  t: (en: string, es: string) => string;
}

/**
 * Bottom sheet wrapper showing InvoiceDetail above active content. Opens from
 * SalesTab (Bible: invoices live within Sales). Backed by BottomSheet so
 * ESC, focus-trap, backdrop-click, and scroll-lock come from Radix Dialog.
 */
export function InvoiceDetailSheet({
  open,
  selectedInvoice,
  business,
  selectedInvoiceBusiness,
  selectedInvoiceCustomer,
  selectedInvoiceSale,
  invoiceStatusNotice,
  setInvoiceStatusNotice,
  downloadingInvoiceId,
  downloadInvoicePdf,
  sendInvoiceByWhatsapp,
  updateInvoiceStatus,
  appendChatHistoryEntry,
  onClose,
  moneyFmt,
  formatDate,
  t,
}: InvoiceDetailSheetProps) {
  return (
    <BottomSheet
      open={open && !!selectedInvoice}
      onClose={onClose}
      ariaLabel={selectedInvoice?.invoiceNumber ?? ""}
      title={selectedInvoice?.invoiceNumber ?? ""}
      t={t}
    >
      {selectedInvoice && (
        <>
          <InvoiceDetail
            business={business}
            selectedInvoice={selectedInvoice}
            selectedInvoiceBusiness={selectedInvoiceBusiness}
            selectedInvoiceCustomer={selectedInvoiceCustomer}
            selectedInvoiceSale={selectedInvoiceSale}
            invoiceStatusNotice={invoiceStatusNotice}
            setInvoiceStatusNotice={setInvoiceStatusNotice}
            downloadingInvoiceId={downloadingInvoiceId}
            downloadInvoicePdf={downloadInvoicePdf}
            sendInvoiceByWhatsapp={sendInvoiceByWhatsapp}
            updateInvoiceStatus={updateInvoiceStatus}
            appendChatHistoryEntry={appendChatHistoryEntry}
            onBackToList={onClose}
            moneyFmt={moneyFmt}
            formatDate={formatDate}
            t={t}
          />
          <button
            type="button"
            data-print-keep
            style={PRINT_BTN_STYLE}
            onClick={() => {
              if (isCapacitor()) {
                alert(t(
                  "Print is not available in the mobile app. Open from a browser.",
                  "Imprimir no disponible en app móvil. Abrí desde el navegador."
                ));
                return;
              }
              window.print();
            }}
          >
            <Printer size={18} weight="regular" aria-hidden />
            {t("Print", "Imprimir")}
          </button>
        </>
      )}
    </BottomSheet>
  );
}
