"use client";

import React, { useEffect, useState, useMemo } from "react";
import { CaretLeftIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import type { InvoiceStatus } from "@/domain";
import type { InvoiceRecord, InvoicePayload, BusinessSummary, ChatHistoryEntry, FeedbackNotice, TabKey } from "../lib/types";
import { useDebouncedValue } from "../lib/hooks/useDebouncedValue";
import { InvoiceList } from "./InvoiceList";
import { InvoiceDetail } from "./InvoiceDetail";
import { SharedEmptyState } from "./SharedEmptyState";
import { SectionMarker } from "./v2/SectionMarker";

function InvoicesIllustration() {
  return (
    <svg width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden style={{ color: "var(--brand)" }}>
      <defs>
        <linearGradient id="empty-invoices-grad" x1="0" y1="0" x2="56" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.95" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0.65" />
        </linearGradient>
      </defs>
      <circle cx="28" cy="28" r="22" stroke="currentColor" strokeOpacity="0.14" strokeWidth="1.5" strokeDasharray="3 5" />
      <path d="M16 11 L38 11 L38 42 L34 39 L30 42 L26 39 L22 42 L18 39 L16 42 Z" fill="url(#empty-invoices-grad)" fillOpacity="0.18" stroke="url(#empty-invoices-grad)" strokeWidth="2" strokeLinejoin="round" />
      <rect x="20" y="18" width="14" height="2" rx="1" fill="currentColor" fillOpacity="0.55" />
      <rect x="20" y="23" width="10" height="2" rx="1" fill="currentColor" fillOpacity="0.4" />
      <rect x="20" y="30" width="14" height="2.5" rx="1" fill="currentColor" fillOpacity="0.75" />
      <path d="M44 16 L45.2 19 L48 20 L45.2 21 L44 24 L42.8 21 L40 20 L42.8 19 Z" fill="currentColor" fillOpacity="0.85" />
    </svg>
  );
}

interface InvoicesTabProps {
  setActiveTab: (tab: TabKey) => void;
  business: BusinessSummary;
  invoices: InvoiceRecord[];
  activeInvoiceId: string | null;
  setActiveInvoiceId: (id: string | null) => void;
  invoiceStatusNotice: FeedbackNotice | null;
  setInvoiceStatusNotice: (value: FeedbackNotice | null) => void;
  downloadingInvoiceId: string | null;
  selectedInvoice: InvoiceRecord | null;
  selectedInvoiceBusiness: InvoicePayload["business"] | undefined;
  selectedInvoiceCustomer: InvoicePayload["customer"] | undefined;
  selectedInvoiceSale: InvoicePayload["sale"] | undefined;
  downloadInvoicePdf: (invoiceId: string, invoiceNumber: string) => void;
  sendInvoiceByWhatsapp: (invoiceId: string, invoiceNumber: string, opts?: Record<string, unknown>) => Promise<{ sentTo?: string; successMessage: string }>;
  updateInvoiceStatus: (invoiceId: string, status: InvoiceStatus) => Promise<void>;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
  moneyFmt: (value: unknown, currency: string) => string;
  formatDate: (value: string) => string;
  t: (en: string, es: string) => string;
}

export const InvoicesTab = React.memo(function InvoicesTab({
  setActiveTab,
  business,
  invoices,
  activeInvoiceId,
  setActiveInvoiceId,
  invoiceStatusNotice,
  setInvoiceStatusNotice,
  downloadingInvoiceId,
  selectedInvoice,
  selectedInvoiceBusiness,
  selectedInvoiceCustomer,
  selectedInvoiceSale,
  downloadInvoicePdf,
  sendInvoiceByWhatsapp,
  updateInvoiceStatus,
  appendChatHistoryEntry,
  moneyFmt,
  formatDate,
  t,
}: InvoicesTabProps) {
  const [mobileView, setMobileView] = useState<"list" | "detail">("list");
  const [search, setSearch] = useState("");

  useEffect(() => {
    // Only auto-select when there is no still-valid current selection.
    // Polling produces new array references each tick, so we must NOT reset
    // the selection on every reference change — only when the current id is gone.
    const selectionIsValid = activeInvoiceId != null && invoices.some((i) => i.id === activeInvoiceId);
    if (!selectionIsValid && invoices.length > 0) {
      setActiveInvoiceId(invoices[0].id);
    }
  }, [activeInvoiceId, invoices, setActiveInvoiceId]);

  function selectInvoice(id: string) {
    setActiveInvoiceId(id);
    setInvoiceStatusNotice(null);
    setMobileView("detail");
  }

  const debouncedSearch = useDebouncedValue(search, 300);

  const filtered = useMemo(() => {
    if (!debouncedSearch.trim()) return invoices;
    const q = debouncedSearch.trim().toLowerCase();
    return invoices.filter((inv) =>
      inv.invoiceNumber.toLowerCase().includes(q) ||
      (inv.payload?.customer?.name ?? "").toLowerCase().includes(q)
    );
  }, [invoices, debouncedSearch]);

  if (invoices.length === 0) {
    return (
      <SharedEmptyState
        illustration={<InvoicesIllustration />}
        title={t("No invoices yet", "Todavía no hay facturas")}
        description={t(
          "Confirm your first sale to generate a receipt. You can download it or send it via WhatsApp.",
          "Confirmá tu primera venta para generar un comprobante. Lo podés descargar o mandar por WhatsApp."
        )}
        action={{ label: t("Add a sale", "Cargá una venta"), onClick: () => setActiveTab("main") }}
      />
    );
  }

  const listPanel = (
    <InvoiceList
      invoices={filtered}
      activeInvoiceId={activeInvoiceId}
      search={search}
      setSearch={setSearch}
      selectInvoice={selectInvoice}
      moneyFmt={moneyFmt}
      formatDate={formatDate}
      t={t}
    />
  );

  // Desktop detail panel — no Back button (there is always a visible list column).
  const detailPanel = selectedInvoice ? (
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
      onBackToList={() => setMobileView("list")}
      moneyFmt={moneyFmt}
      formatDate={formatDate}
      t={t}
    />
  ) : (
    <p className="text-caption" style={{ color: "var(--tone-muted)" }}>
      {t("Select an invoice from the list to see its details.", "Seleccioná una factura de la lista para ver los detalles.")}
    </p>
  );

  // Mobile detail panel — adds a Back button so the user can return to the list.
  const mobileDetailPanel = selectedInvoice ? detailPanel : (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="ghost"
        onClick={() => setMobileView("list")}
        className="self-start gap-1.5"
      >
        <CaretLeftIcon weight="bold" aria-hidden /> {t("Back", "Volver")}
      </Button>
      <p className="text-caption" style={{ color: "var(--tone-muted)" }}>
        {t("Select an invoice from the list to see its details.", "Seleccioná una factura de la lista para ver los detalles.")}
      </p>
    </div>
  );

  return (
    <div className="flex flex-col gap-4">
      {/* v2 editorial header */}
      <div className="flex flex-col gap-1.5">
        <SectionMarker label={t("Operation", "Operación")} number="02" />
        <h1
          className="t-display-3"
          style={{ color: "var(--tone-strong)", margin: 0 }}
        >
          {t("Invoices", "Comprobantes")}
        </h1>
      </div>

      <div className="hidden xl:grid gap-5 xl:grid-cols-[15.5rem_minmax(0,1fr)]">
        {listPanel}
        {detailPanel}
      </div>

      <div className="xl:hidden" key={mobileView} style={{ animation: "fadeUp 200ms ease both" }}>
        {mobileView === "list" ? listPanel : mobileDetailPanel}
      </div>
    </div>
  );
});
