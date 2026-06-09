import { ReceiptIcon, CaretRightIcon } from "@phosphor-icons/react";
import React, { useState, useMemo, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import type { CashMovement } from "@/domain";
import type { BusinessSummary, InvoiceRecord, SaleRecord } from "../lib/types";
import { LastUpdated } from "./LastUpdated";
import { formatDateLabel } from "../lib/helpers";
import { SectionMarker } from "./v2/SectionMarker";
import { DailySummary } from "./DailySummary";
import { BottomSheet } from "./BottomSheet";
import { computeTodaySummary } from "../lib/today-summary";

const SECTION_STYLE: CSSProperties = { display: "flex", flexDirection: "column", gap: "1.25rem" };
const HERO_LABEL_STYLE: CSSProperties = { fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)", fontWeight: 600 };
const HERO_ROW_STYLE: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.25rem" };

const MOVEMENT_NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  color: "var(--tone-strong)",
  margin: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};
const MOVEMENT_DATE_STYLE: CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  margin: "2px 0 0",
};
const DATE_DIVIDER_STYLE: CSSProperties = { textAlign: "center", padding: "12px 0 8px", color: "var(--tone-muted)", fontWeight: 500 };

interface SalesTabProps {
  business: BusinessSummary;
  cashMovements: CashMovement[];
  invoices: InvoiceRecord[];
  sales: SaleRecord[];
  currentCash: number;
  lastUpdatedTimestamp: number | null;
  moneyFmt: (value: unknown, currency: string) => string;
  formatDate: (value: string) => string;
  formatTime: (value: string) => string;
  movementDescriptionLabel: (movement: CashMovement) => string;
  t: (en: string, es: string) => string;
  onViewInvoice: (id: string) => void;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export const SalesTab = React.memo(function SalesTab({
  business,
  cashMovements,
  invoices,
  sales,
  currentCash,
  lastUpdatedTimestamp,
  moneyFmt,
  formatDate,
  formatTime,
  movementDescriptionLabel,
  t,
  onViewInvoice,
}: SalesTabProps) {
  const [selectedMovementId, setSelectedMovementId] = useState<string | null>(null);

  const selectedMovement = cashMovements.find(m => m.id === selectedMovementId);
  const linkedInvoice = useMemo(() => {
    if (!selectedMovement?.saleId) return null;
    return invoices.find(inv => inv.saleId === selectedMovement.saleId) ?? null;
  }, [selectedMovement, invoices]);

  const linkedSale = useMemo(() => {
    if (!selectedMovement?.saleId) return null;
    return sales.find(s => s.id === selectedMovement.saleId) ?? null;
  }, [selectedMovement, sales]);

  const fmtMoney = (v: number) => moneyFmt(Math.abs(v), business.currency).replace(/^[A-Z]+\s*/, "$");
  const fmtMoneyWithSign = (v: number) => (v < 0 ? "-" : "") + fmtMoney(v);

  const todaySummary = useMemo(() => computeTodaySummary(cashMovements), [cashMovements]);

  return (
    <div style={SECTION_STYLE}>
      {/* v2 editorial header */}
      <div className="flex flex-col gap-1.5">
        <SectionMarker label={t("Operations", "Operación")} number="01" />
        <h1 className="t-display-3" style={{ color: "var(--tone-strong)", margin: 0 }}>
          {t("Cash Register", "Caja")}
        </h1>
      </div>

      {/* ── Cash balance hero ── */}
      <div style={{ padding: "0 0 0.75rem" }}>
        <div style={HERO_ROW_STYLE}>
          <span className="text-caption" style={HERO_LABEL_STYLE}>
            {t("Cash balance", "Saldo en caja")}
          </span>
          <LastUpdated timestamp={lastUpdatedTimestamp} t={t} />
        </div>

        <p style={{
          fontFamily: "var(--font-fraunces)",
          fontSize: "clamp(1.75rem, 6vw, 2.25rem)",
          fontWeight: 500,
          color: currentCash < 0 ? "var(--danger)" : "var(--tone-strong)",
          letterSpacing: "var(--track-display)",
          margin: 0,
          lineHeight: 1.2,
        }}>
          {fmtMoneyWithSign(currentCash)}
        </p>

        <DailySummary
          sales={todaySummary.sales}
          expenses={todaySummary.expenses}
          net={todaySummary.net}
          hasMovements={todaySummary.hasMovements}
          moneyFmt={moneyFmt}
          currency={business.currency}
          t={t}
        />
      </div>

      {/* ── Movement list ── */}
      {cashMovements.length === 0 ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "12px", padding: "3rem 1rem" }}>
          <ReceiptIcon size={48} weight="duotone" color="var(--tone-faint)" />
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", textAlign: "center", margin: 0 }}>
            {t(
              "No movements yet. Confirm a sale or record a movement to see it here.",
              "Todavía no hay movimientos. Confirmá una venta o registrá un movimiento para verlo aquí."
            )}
          </p>
        </div>
      ) : (
        <div>
          {cashMovements.map((movement, index) => {
            const isIncome = movement.amount >= 0;
            const prevMovement = index > 0 ? cashMovements[index - 1] : null;
            const showDateDivider = !prevMovement ||
              new Date(movement.date).toDateString() !== new Date(prevMovement.date).toDateString();
            return (
              <React.Fragment key={movement.id}>
                {showDateDivider && (
                  <div className="text-caption" style={DATE_DIVIDER_STYLE}>
                    {formatDateLabel(movement.date)}
                  </div>
                )}
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSelectedMovementId(movement.id)}
                className="list-row w-full h-auto justify-start px-0 rounded-none"
              >
                {/* Color indicator */}
                <div style={{
                  width: "3px",
                  height: "32px",
                  borderRadius: "2px",
                  backgroundColor: isIncome ? "var(--success)" : "var(--danger)",
                  flexShrink: 0,
                }} />

                <div style={{ minWidth: 0, flex: 1, paddingRight: "0.25rem" }}>
                  <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "0.5rem" }}>
                    <p className="text-body-strong" style={MOVEMENT_NAME_STYLE}>
                      {movementDescriptionLabel(movement)}
                    </p>
                    <span className="text-body-strong" style={{
                      fontFamily: "var(--font-dm-sans)",
                      fontWeight: 700,
                      color: isIncome ? "var(--success)" : "var(--danger)",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                      fontVariantNumeric: "tabular-nums",
                      overflow: "visible",
                    }}>
                      {isIncome ? "+" : "-"}{fmtMoney(movement.amount)}
                    </span>
                  </div>
                  <p className="text-caption" style={MOVEMENT_DATE_STYLE}>
                    {formatDate(movement.date)} · {formatTime(movement.date)}
                  </p>
                </div>
              </Button>
              </React.Fragment>
            );
          })}
        </div>
      )}

      {/* ── Movement Detail Sheet ── */}
      <BottomSheet
        open={!!selectedMovement}
        onClose={() => setSelectedMovementId(null)}
        ariaLabel={selectedMovement ? movementDescriptionLabel(selectedMovement) : ""}
        title={selectedMovement ? movementDescriptionLabel(selectedMovement) : ""}
        t={t}
      >
        {selectedMovement && (
          <>
            <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", marginTop: "-0.5rem", marginBottom: "1.5rem" }}>
              {formatDate(selectedMovement.date)} · {formatTime(selectedMovement.date)}
            </p>

            {/* Amount */}
            <div className="rounded-token-lg" style={{
              padding: "1.25rem",
              backgroundColor: "var(--surface-subtle)",
              marginBottom: "1rem",
            }}>
              <span className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600 }}>
                {t("Amount", "Monto")}
              </span>
              <p className="text-display" style={{
                fontFamily: "var(--font-fraunces)",
                fontWeight: 500,
                color: selectedMovement.amount >= 0 ? "var(--success)" : "var(--danger)",
                fontVariantNumeric: "tabular-nums",
                letterSpacing: "var(--track-display)",
                margin: "0.25rem 0 0",
              }}>
                {selectedMovement.amount >= 0 ? "+" : "-"}{fmtMoney(selectedMovement.amount)}
              </p>
            </div>

            {/* Sale items */}
            {linkedSale && linkedSale.items.length > 0 && (
              <div style={{ marginBottom: "1rem" }}>
                <span className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600 }}>
                  {t("Items sold", "Productos vendidos")}
                </span>
                <div style={{ marginTop: "0.5rem", display: "flex", flexDirection: "column", gap: "0.375rem" }}>
                  {linkedSale.items.map((item, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "0.5rem" }}>
                      <span className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-body)" }}>
                        {item.quantity}× {item.product.name}
                      </span>
                      <span className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--tone-strong)", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                        {fmtMoney(item.quantity * item.unitPrice)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Invoice link */}
            {linkedInvoice && (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSelectedMovementId(null);
                  onViewInvoice(linkedInvoice.id);
                }}
                className="rounded-token-lg w-full h-auto justify-between px-4 py-4 mb-4"
              >
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <ReceiptIcon className="icon-base" weight="duotone" color="var(--brand)" />
                  <div style={{ textAlign: "left" }}>
                    <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 700, color: "var(--tone-strong)", margin: 0 }}>
                      {t("View invoice", "Ver factura")}
                    </p>
                    <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--brand)", fontWeight: 600, margin: 0 }}>
                      #{linkedInvoice.invoiceNumber}
                    </p>
                  </div>
                </div>
                <CaretRightIcon className="icon-base" color="var(--tone-muted)" />
              </Button>
            )}

            {/* Meta */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1.5rem" }}>
              <div>
                <span className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600 }}>
                  {t("Category", "Categoría")}
                </span>
                <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--tone-strong)", margin: "0.125rem 0 0" }}>
                  {selectedMovement.amount >= 0 ? t("Sale / Income", "Venta / Ingreso") : t("Expense / Outflow", "Gasto / Egreso")}
                </p>
              </div>
              <div>
                <span className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600 }}>
                  {t("Status", "Estado")}
                </span>
                <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--success)", margin: "0.125rem 0 0" }}>
                  {t("Confirmed", "Confirmado")}
                </p>
              </div>
            </div>

            {selectedMovement.description.toLowerCase().includes("venta") && !linkedInvoice && (
              <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", textAlign: "center", padding: "0.5rem 0" }}>
                {t("Sale confirmed without invoice.", "Venta confirmada sin factura.")}
              </p>
            )}

            <Button
              type="button"
              variant="secondary"
              onClick={() => setSelectedMovementId(null)}
              className="w-full"
            >
              {t("Done", "Listo")}
            </Button>
          </>
        )}
      </BottomSheet>
    </div>
  );
});
