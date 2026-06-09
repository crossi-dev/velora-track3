"use client";

import type { StockTableWidget as StockTableDescriptor } from "../../lib/types";
import { useDashboardLang } from "../../lib/DashboardLangContext";

// Read-only stock table rendered in-chat below the assistant bubble (ChatRow.tsx).
// Styling mirrors SalesSummaryWidget: CSS vars (--surface-subtle / --tone-strong
// / --bubble-border), rem typography (body ≥1rem, captions ≥0.875rem), ≥44px
// touch targets. No interaction (read-only slice).

const CARD_STYLE: React.CSSProperties = {
  marginTop: "8px",
  alignSelf: "flex-start",
  maxWidth: "100%",
  width: "fit-content",
  minWidth: "min-content",
  padding: "14px 16px",
  borderRadius: "16px",
  backgroundColor: "var(--surface-subtle)",
  border: "1px solid var(--bubble-border)",
  display: "flex",
  flexDirection: "column",
  gap: "10px",
};

const HEADER_STYLE: React.CSSProperties = {
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--tone-muted)",
  letterSpacing: "0.01em",
  lineHeight: 1.3,
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

const TABLE_STYLE: React.CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
};

const TH_STYLE: React.CSSProperties = {
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--tone-muted)",
  textAlign: "left",
  padding: "6px 12px 6px 0",
  lineHeight: 1.3,
};

const TH_NUM_STYLE: React.CSSProperties = { ...TH_STYLE, textAlign: "right", paddingRight: 0 };

const TD_STYLE: React.CSSProperties = {
  fontSize: "1rem",
  color: "var(--tone-strong)",
  padding: "8px 12px 8px 0",
  lineHeight: 1.3,
  minHeight: "44px",
};

const TD_NUM_STYLE: React.CSSProperties = { ...TD_STYLE, textAlign: "right", paddingRight: 0, fontWeight: 600 };

export function StockTableWidget({ descriptor }: { descriptor: StockTableDescriptor }) {
  const { t, lang } = useDashboardLang();
  const { title, rows } = descriptor.data;
  const fmtPrice = (n: number) =>
    n.toLocaleString(lang === "en" ? "en-US" : "es-AR", {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });

  return (
    <div style={CARD_STYLE} role="group" aria-label={t("Stock table", "Tabla de stock")}>
      <span style={HEADER_STYLE}>📦 {title}</span>
      <table style={TABLE_STYLE}>
        <thead>
          <tr>
            <th style={TH_STYLE}>{t("Product", "Producto")}</th>
            <th style={TH_NUM_STYLE}>{t("Qty", "Cant.")}</th>
            <th style={TH_NUM_STYLE}>{t("Price", "Precio")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={`${row.name}-${i}`}>
              <td style={TD_STYLE}>{row.name}</td>
              <td style={TD_NUM_STYLE}>{row.qty}</td>
              <td style={TD_NUM_STYLE}>{fmtPrice(row.price)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
