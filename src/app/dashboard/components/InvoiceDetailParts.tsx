"use client";

import { DownloadSimpleIcon, WhatsappLogoIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import type { InvoiceStatus } from "@/domain";
import type { InvoicePayload, BusinessSummary } from "../lib/types";
import { Button } from "@/components/ui/button";
import { buildCustomerFullName, splitCustomerName } from "../lib/helpers";
import { StatusPill, DocumentTypePill, STATUS_NEXT } from "./InvoiceStatusPills";

const FONT_DM = "var(--font-dm-sans)";
const FONT_FR = "var(--font-fraunces)";

export { FONT_DM, FONT_FR };

export function InvoiceHeader({
  invoiceNumber, documentType, status, date, total, currencyPrefix, onChangeStatus, formatDate, t,
}: {
  invoiceNumber: string;
  documentType: NonNullable<import("../lib/types").InvoiceRecord["documentType"]>;
  status: InvoiceStatus;
  date: string;
  total: string;
  currencyPrefix: string;
  onChangeStatus: () => void;
  formatDate: (value: string) => string;
  t: (en: string, es: string) => string;
}) {
  const nextStatus = STATUS_NEXT[status];
  const canCycle = nextStatus !== status;
  return (
    <div className="flex flex-wrap items-end justify-between gap-y-3 gap-x-4 pb-4" style={{ borderBottom: "1px solid var(--border)" }}>
      <div style={{ minWidth: 0, flex: "1 0 220px" }}>
        <div className="flex flex-wrap items-center gap-2">
          <p style={{ fontFamily: FONT_DM, fontWeight: 600, fontSize: "1.0625rem", color: "var(--tone-strong)", margin: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {invoiceNumber}
          </p>
          <DocumentTypePill documentType={documentType} t={t} />
          <StatusPill status={status} t={t} onClick={canCycle ? onChangeStatus : undefined} />
        </div>
        <p style={{ fontFamily: FONT_DM, fontSize: "0.875rem", color: "var(--tone-muted)", margin: "4px 0 0 0", letterSpacing: "0.005em" }}>
          {formatDate(date)}
        </p>
      </div>
      <div className="flex-shrink-0" style={{ marginLeft: "auto", textAlign: "right" }}>
        <p style={{ fontFamily: FONT_DM, fontSize: "0.875rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--tone-muted)", margin: "0 0 4px 0" }}>
          {t("Total", "Total")}
        </p>
        <p style={{ fontFamily: FONT_FR, fontWeight: 500, fontSize: "clamp(2rem, 3.6vw, 2.75rem)", letterSpacing: "-0.018em", lineHeight: 1, color: "var(--tone-strong)", margin: 0, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
          {currencyPrefix}{total}
        </p>
      </div>
    </div>
  );
}

export function InvoiceParties({ business, invoiceBusiness, customer, t }: {
  business: BusinessSummary;
  invoiceBusiness: InvoicePayload["business"] | undefined;
  customer: InvoicePayload["customer"] | undefined;
  t: (en: string, es: string) => string;
}) {
  const customerFullName = buildCustomerFullName(
    customer?.firstName ?? splitCustomerName(customer?.name ?? "").firstName,
    customer?.lastName ?? splitCustomerName(customer?.name ?? "").lastName,
  ) || customer?.name || "—";

  const labelStyle: React.CSSProperties = { fontFamily: FONT_DM, fontSize: "0.875rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--tone-muted)", margin: "0 0 6px 0" };

  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <div>
        <p style={labelStyle}>{t("From", "De")}</p>
        <p style={{ fontFamily: FONT_DM, fontWeight: 600, color: "var(--tone-strong)", margin: 0, fontSize: "0.9375rem" }}>{invoiceBusiness?.name ?? business.name}</p>
        <p style={{ fontFamily: FONT_DM, fontSize: "0.875rem", color: "var(--tone-muted)", margin: "4px 0 0 0", lineHeight: 1.5 }}>
          {[invoiceBusiness?.cuit ? `CUIT: ${invoiceBusiness.cuit}` : null, invoiceBusiness?.address].filter(Boolean).join(" · ")}
        </p>
      </div>
      <div>
        <p style={labelStyle}>{t("To", "Para")}</p>
        <p style={{ fontFamily: FONT_DM, fontWeight: 600, color: "var(--tone-strong)", margin: 0, fontSize: "0.9375rem" }}>{customerFullName}</p>
        <p style={{ fontFamily: FONT_DM, fontSize: "0.875rem", color: "var(--tone-muted)", margin: "4px 0 0 0", lineHeight: 1.5 }}>
          {[customer?.taxId ? `CUIT/CUIL: ${customer.taxId}` : null, customer?.email ?? null, customer?.phone ?? null].filter(Boolean).join(" · ") || "—"}
        </p>
      </div>
    </div>
  );
}

export function InvoiceItemsTable({ items, currency, moneyFmt, t }: {
  items: NonNullable<InvoicePayload["sale"]>["items"];
  currency: string;
  moneyFmt: (value: unknown, currency: string) => string;
  t: (en: string, es: string) => string;
}) {
  const monoNum: React.CSSProperties = { fontFamily: FONT_DM, fontVariantNumeric: "tabular-nums", letterSpacing: "0.01em" };
  return (
    <div className="mt-5">
      <div className="flex flex-col gap-2 md:hidden">
        {items.map((item, i) => (
          <div key={`mob-${i}`} className="rounded-xl border px-4 py-3.5" style={{ borderColor: "var(--border)", backgroundColor: "var(--surface)" }}>
            <p style={{ fontFamily: FONT_DM, fontWeight: 600, color: "var(--tone-strong)", margin: 0, fontSize: "0.9375rem" }}>{item.productName}</p>
            <div className="mt-2 flex items-baseline justify-between">
              <p style={{ ...monoNum, fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0 }}>{item.quantity} × {moneyFmt(item.unitPrice, currency)}</p>
              <p style={{ ...monoNum, fontSize: "0.9375rem", fontWeight: 700, color: "var(--tone-strong)", margin: 0 }}>{moneyFmt(item.subtotal, currency)}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="hidden md:block">
        <div className="overflow-hidden rounded-xl border" style={{ borderColor: "var(--border)" }}>
          <div className="grid px-4 py-3" style={{ backgroundColor: "var(--surface-subtle)", gridTemplateColumns: "minmax(0,1fr) 4.5rem 8rem 8rem", fontFamily: FONT_DM, fontSize: "0.875rem", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--tone-muted)" }}>
            <span>{t("Item", "Ítem")}</span>
            <span style={{ textAlign: "right" }}>{t("Qty.", "Cant.")}</span>
            <span style={{ textAlign: "right" }}>{t("Price", "Precio")}</span>
            <span style={{ textAlign: "right" }}>{t("Subtotal", "Subtotal")}</span>
          </div>
          {items.map((item, i) => (
            <div key={`row-${i}`} className="grid items-center px-4 py-3" style={{ gridTemplateColumns: "minmax(0,1fr) 4.5rem 8rem 8rem", borderTop: "1px solid var(--border)", fontFamily: FONT_DM, fontSize: "0.875rem", color: "var(--tone-strong)", backgroundColor: "var(--surface)" }}>
              <span>{item.productName}</span>
              <span style={{ ...monoNum, textAlign: "right", color: "var(--tone-body)" }}>{item.quantity}</span>
              <span style={{ ...monoNum, textAlign: "right", color: "var(--tone-body)" }}>{moneyFmt(item.unitPrice, currency)}</span>
              <span style={{ ...monoNum, textAlign: "right", fontWeight: 600 }}>{moneyFmt(item.subtotal, currency)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function InvoiceStatusBar({ pendingStatus, onConfirm, onCancel, isPending, t }: {
  pendingStatus: InvoiceStatus;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
  t: (en: string, es: string) => string;
}) {
  const label = pendingStatus === "sent" ? t("Sent", "Enviada") : t("Paid", "Pagada");
  return (
    <div className="mt-4 rounded-xl border px-4 py-3 flex items-center justify-between gap-3" style={{ borderColor: "var(--brand-accent)", backgroundColor: "var(--brand-soft)" }}>
      <p style={{ fontFamily: FONT_DM, fontSize: "0.875rem", color: "var(--tone-strong)", margin: 0 }}>
        {t(`Change status to "${label}"?`, `¿Cambiar estado a "${label}"?`)}
      </p>
      <div className="flex gap-2 flex-shrink-0">
        <Button type="button" size="sm" onClick={onConfirm} disabled={isPending}>
          {isPending ? t("Saving…", "Guardando…") : t("Confirm", "Confirmar")}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          {t("Cancel", "Cancelar")}
        </Button>
      </div>
    </div>
  );
}

export function InvoiceActions({ status, hasPhone, isDownloading, isPendingAction, onMarkSent, onDownload, onWhatsApp, t }: {
  status: InvoiceStatus;
  hasPhone: boolean;
  isDownloading: boolean;
  isPendingAction: boolean;
  onMarkSent: (() => void) | null;
  onDownload: () => void;
  onWhatsApp: () => void;
  t: (en: string, es: string) => string;
}) {
  const showPrimaryMarkSent = status === "issued" && onMarkSent !== null;
  return (
    <div className="mt-5">
      {showPrimaryMarkSent && (
        <Button type="button" onClick={onMarkSent ?? undefined} disabled={isPendingAction} className="w-full sm:w-auto px-5 mb-3 gap-1.5">
          <PaperPlaneTiltIcon weight="bold" aria-hidden />
          {t("Mark as sent", "Marcar como enviada")}
        </Button>
      )}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="button" variant="outline" onClick={onDownload} disabled={isDownloading} className="w-full sm:w-auto px-5 gap-1.5">
          <DownloadSimpleIcon weight="bold" aria-hidden />
          {isDownloading ? t("Downloading...", "Descargando...") : t("Download PDF", "Descargar PDF")}
        </Button>
        {hasPhone && (
          <Button type="button" variant="outline" onClick={onWhatsApp} disabled={isPendingAction} className="w-full sm:w-auto px-5 gap-1.5">
            <WhatsappLogoIcon weight="fill" aria-hidden />
            {isPendingAction ? t("Sending…", "Enviando…") : t("Send via WhatsApp", "Enviar por WhatsApp")}
          </Button>
        )}
      </div>
    </div>
  );
}
