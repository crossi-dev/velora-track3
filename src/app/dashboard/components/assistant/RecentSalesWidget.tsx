"use client";

import type { RecentSalesWidget as RecentSalesDescriptor } from "../../lib/types";
import { useDashboardLang } from "../../lib/DashboardLangContext";

// Read-only recent-sales table rendered in-chat below the assistant bubble
// (ChatRow.tsx). Shows top products by quantity for a period plus the period
// total. Styling mirrors SalesSummaryWidget: CSS vars, rem typography
// (body ≥1rem, captions ≥0.875rem), ≥44px touch targets. No interaction.

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

const TOTAL_STYLE: React.CSSProperties = {
  fontSize: "1.5rem",
  fontWeight: 700,
  color: "var(--tone-strong)",
  lineHeight: 1.2,
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

export function RecentSalesWidget({ descriptor }: { descriptor: RecentSalesDescriptor }) {
  const { t, lang } = useDashboardLang();
  const { periodLabel, totalARS, rows } = descriptor.data;
  const fmtMoney = (n: number) =>
    n.toLocaleString(lang === "en" ? "en-US" : "es-AR", {
      style: "currency",
      currency: "ARS",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });

  return (
    <div style={CARD_STYLE} role="group" aria-label={t("Recent sales", "Ventas recientes")}>
      <span style={HEADER_STYLE}>
        🧾 {t("Sales", "Ventas")} · {periodLabel}
      </span>
      <span style={TOTAL_STYLE}>{fmtMoney(totalARS)}</span>
      {rows.length > 0 && (
        <table style={TABLE_STYLE}>
          <thead>
            <tr>
              <th style={TH_STYLE}>{t("Product", "Producto")}</th>
              <th style={TH_NUM_STYLE}>{t("Qty", "Cant.")}</th>
              <th style={TH_NUM_STYLE}>{t("Amount", "Monto")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={`${row.product}-${i}`}>
                <td style={TD_STYLE}>{row.product}</td>
                <td style={TD_NUM_STYLE}>{row.qtyTotal}</td>
                <td style={TD_NUM_STYLE}>{fmtMoney(row.amountARS)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
