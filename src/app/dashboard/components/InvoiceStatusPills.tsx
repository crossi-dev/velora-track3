"use client";

import type { InvoiceStatus } from "@/domain";
import type { DocumentType } from "../lib/types";

export const STATUS_META: Record<InvoiceStatus, { label: string; labelEs: string; color: string; badgeClass: string }> = {
  issued: { label: "Issued",  labelEs: "Emitida", color: "var(--tone-muted)",  badgeClass: "badge-neutral" },
  sent:   { label: "Sent",    labelEs: "Enviada",  color: "var(--brand)",       badgeClass: "badge-brand" },
  paid:   { label: "Paid",    labelEs: "Pagada",   color: "var(--success)",     badgeClass: "badge-success" },
};

export const STATUS_NEXT: Record<InvoiceStatus, InvoiceStatus> = {
  issued: "sent",
  sent: "paid",
  paid: "paid",
};

export function StatusPill({
  status, onClick, t,
}: { status: InvoiceStatus; onClick?: () => void; t: (en: string, es: string) => string }) {
  const meta = STATUS_META[status] ?? STATUS_META.issued;
  const label = t(meta.label, meta.labelEs);
  return (
    <span
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") onClick(); } : undefined}
      className={`badge ${meta.badgeClass}`}
      style={{
        whiteSpace: "nowrap",
        flexShrink: 0,
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
      }}
    >
      {label}
    </span>
  );
}

export function DocumentTypePill({ documentType, t }: { documentType: DocumentType; t: (en: string, es: string) => string }) {
  const isInvoice = documentType === "invoice";
  const label = isInvoice
    ? t("Invoice", "Factura")
    : t("Sales receipt", "Comprobante de venta");
  return (
    <span
      className={`badge ${isInvoice ? "badge-brand" : "badge-warning"}`}
      style={{ whiteSpace: "nowrap", flexShrink: 0 }}
    >
      {label}
    </span>
  );
}
