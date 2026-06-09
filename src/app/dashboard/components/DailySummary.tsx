import React, { type CSSProperties } from "react";

interface DailySummaryProps {
  sales: number;
  expenses: number;
  net: number;
  hasMovements: boolean;
  moneyFmt: (value: unknown, currency: string) => string;
  currency: string;
  t: (en: string, es: string) => string;
}

const SECTION_STYLE: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.375rem",
  paddingTop: "0.75rem",
  marginTop: "0.5rem",
  borderTop: "1px solid var(--border)",
};

const LABEL_STYLE: CSSProperties = {
  color: "var(--tone-muted)",
  fontWeight: 600,
  marginBottom: "0.125rem",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
};

const NAME_STYLE: CSSProperties = {
  color: "var(--tone-body)",
  margin: 0,
};

const VALUE_STYLE: CSSProperties = {
  // v3 — montos del día en Fraunces para alinear con KpiCard / editorial type system
  fontFamily: "var(--font-fraunces)",
  fontWeight: 500,
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "-0.005em",
  margin: 0,
};

export const DailySummary = React.memo(function DailySummary({
  sales,
  expenses,
  net,
  hasMovements,
  moneyFmt,
  currency,
  t,
}: DailySummaryProps) {
  if (!hasMovements) return null;

  const fmt = (value: number) => moneyFmt(Math.abs(value), currency).replace(/^[A-Z]+\s*/, "$");

  const netColor =
    net > 0 ? "var(--success)" : net < 0 ? "var(--danger)" : "var(--tone-strong)";
  const netSign = net >= 0 ? "+" : "-";

  return (
    <div style={SECTION_STYLE}>
      <span className="text-caption" style={LABEL_STYLE}>
        {t("Today", "Hoy")}
      </span>
      <div style={ROW_STYLE}>
        <p className="text-caption" style={NAME_STYLE}>
          {t("Sales", "Ventas")}
        </p>
        <p className="text-caption" style={{ ...VALUE_STYLE, color: "var(--success)" }}>
          +{fmt(sales)}
        </p>
      </div>
      <div style={ROW_STYLE}>
        <p className="text-caption" style={NAME_STYLE}>
          {t("Expenses", "Gastos")}
        </p>
        <p className="text-caption" style={{ ...VALUE_STYLE, color: "var(--danger)" }}>
          -{fmt(expenses)}
        </p>
      </div>
      <div style={ROW_STYLE}>
        <p className="text-caption" style={NAME_STYLE}>
          {t("Difference", "Diferencia")}
        </p>
        <p className="text-caption" style={{ ...VALUE_STYLE, color: netColor }}>
          {netSign}
          {fmt(net)}
        </p>
      </div>
    </div>
  );
});
