"use client";

import type { SalesSummaryWidget as SalesSummaryDescriptor } from "../../lib/types";
import { useDashboardLang } from "../../lib/DashboardLangContext";

// Read-only KPI card for a sales period. Rendered in-chat as a sibling of the
// assistant bubble (see ChatRow.tsx). Styling follows Velora conventions:
// CSS vars (--surface-subtle / --tone-strong / --bubble-border), rem typography
// (body ≥1rem, captions ≥0.875rem), ≥44px min height. No interaction (slice 1).

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

const ROW_STYLE: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px 20px",
};

const STAT_LABEL_STYLE: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--tone-muted)",
  lineHeight: 1.3,
};

const STAT_VALUE_STYLE: React.CSSProperties = {
  fontSize: "1rem",
  fontWeight: 600,
  color: "var(--tone-strong)",
  lineHeight: 1.3,
};

export function SalesSummaryWidget({ descriptor }: { descriptor: SalesSummaryDescriptor }) {
  const { t, lang } = useDashboardLang();
  const { totalARS, count, topProduct, periodLabel } = descriptor.data;

  const totalLabel = totalARS.toLocaleString(lang === "en" ? "en-US" : "es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  return (
    <div style={CARD_STYLE} role="group" aria-label={t("Sales summary", "Resumen de ventas")}>
      <span style={HEADER_STYLE}>
        📊 {t("Sales", "Ventas")} · {periodLabel}
      </span>
      <span style={TOTAL_STYLE}>{totalLabel}</span>
      <div style={ROW_STYLE}>
        <div>
          <div style={STAT_LABEL_STYLE}>{t("Sales count", "N° de ventas")}</div>
          <div style={STAT_VALUE_STYLE}>{count}</div>
        </div>
        <div>
          <div style={STAT_LABEL_STYLE}>{t("Top product", "Producto top")}</div>
          <div style={STAT_VALUE_STYLE}>{topProduct ?? t("—", "—")}</div>
        </div>
      </div>
    </div>
  );
}
