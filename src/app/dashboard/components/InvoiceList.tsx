"use client";

import React, { useRef, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { MagnifyingGlassIcon, CaretRightIcon, XIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { InvoiceRecord } from "../lib/types";
import { STATUS_META } from "./InvoiceStatusPills";

const INVOICE_PRIMARY_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  color: "var(--tone-strong)",
  margin: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const INVOICE_AMOUNT_STYLE: CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  color: "var(--tone-strong)",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const INVOICE_SECONDARY_TEXT_STYLE: CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  margin: "2px 0 0",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

interface InvoiceListProps {
  invoices: InvoiceRecord[];
  activeInvoiceId: string | null;
  search: string;
  setSearch: (value: string) => void;
  selectInvoice: (id: string) => void;
  moneyFmt: (value: unknown, currency: string) => string;
  formatDate: (value: string) => string;
  t: (en: string, es: string) => string;
}

const ROW_HEIGHT = 72;

const INVOICE_BUTTON_BASE: CSSProperties = {
  border: "none",
  cursor: "pointer",
};

const CHEVRON_STYLE: CSSProperties = { color: "var(--tone-muted)", flexShrink: 0 };

const InvoiceRow = React.memo(function InvoiceRow({
  invoice,
  isSelected,
  selectInvoice,
  moneyFmt,
  formatDate,
}: {
  invoice: InvoiceRecord;
  isSelected: boolean;
  selectInvoice: (id: string) => void;
  moneyFmt: (value: unknown, currency: string) => string;
  formatDate: (value: string) => string;
}) {
  const amount = moneyFmt(invoice.totalAmount, invoice.currency).replace(/^[A-Z]+\s*/, "$");
  const secondaryParts: string[] = [];
  if (invoice.payload?.customer?.name) secondaryParts.push(invoice.payload.customer.name);
  secondaryParts.push(formatDate(invoice.issuedAt));
  const statusMeta = STATUS_META[invoice.status ?? "issued"] ?? STATUS_META.issued;

  return (
    <button
      type="button"
      onClick={() => selectInvoice(invoice.id)}
      className="list-row w-full text-left"
      style={{
        ...INVOICE_BUTTON_BASE,
        background: isSelected ? "var(--surface-subtle)" : "none",
      }}
    >
      <span
        aria-hidden
        className="rounded-pill"
        style={{
          width: "8px",
          height: "8px",
          backgroundColor: statusMeta.color,
          flexShrink: 0,
        }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-body-strong" style={INVOICE_PRIMARY_TEXT_STYLE}>{invoice.invoiceNumber}</p>
          <span className="text-body-strong" style={INVOICE_AMOUNT_STYLE}>{amount}</span>
        </div>
        <p className="text-caption" style={INVOICE_SECONDARY_TEXT_STYLE}>{secondaryParts.join(" · ")}</p>
      </div>
      <CaretRightIcon className="icon-sm" style={CHEVRON_STYLE} aria-hidden />
    </button>
  );
});

export function InvoiceList({
  invoices,
  activeInvoiceId,
  search,
  setSearch,
  selectInvoice,
  moneyFmt,
  formatDate,
  t,
}: InvoiceListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: invoices.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <div className="relative w-full flex items-center">
          <MagnifyingGlassIcon className="icon-xs absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--tone-muted)" }} aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search invoices…", "Buscar facturas…")}
            aria-label={t("Search invoices", "Buscar facturas")}
            className="pl-8 h-10 bg-[var(--surface-subtle)] border-transparent focus-visible:border-input focus-visible:bg-background"
          />
          {search.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setSearch("")}
              aria-label={t("Clear search", "Limpiar búsqueda")}
              className="absolute right-0 top-0 h-full w-11 text-[var(--tone-muted)]"
            >
              <XIcon weight="bold" aria-hidden />
            </Button>
          )}
        </div>
      </div>

      {invoices.length === 0 ? (
        <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)" }}>
          {t("No invoices found.", "No se encontraron facturas.")}
        </p>
      ) : (
        <div
          ref={parentRef}
          style={{ height: "min(60vh, 480px)", overflowY: "auto" }}
        >
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const invoice = invoices[virtualRow.index];
              return (
                <div
                  key={invoice.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <InvoiceRow
                    invoice={invoice}
                    isSelected={invoice.id === activeInvoiceId}
                    selectInvoice={selectInvoice}
                    moneyFmt={moneyFmt}
                    formatDate={formatDate}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
