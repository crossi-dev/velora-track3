"use client";

import { CaretDown, CaretUp } from "@phosphor-icons/react";
import type { StockMovement } from "@/domain";

export function RecentMovements({
  recentStockMovements,
  showRecentMovements,
  setShowRecentMovements,
  movementKindLabel,
  formatTime,
  t,
}: {
  recentStockMovements: StockMovement[];
  showRecentMovements: boolean;
  setShowRecentMovements: (fn: (v: boolean) => boolean) => void;
  movementKindLabel: (m: StockMovement) => string;
  formatTime: (value: string) => string;
  t: (en: string, es: string) => string;
}) {
  return (
    <div>
      <button
        type="button"
        aria-expanded={showRecentMovements}
        aria-controls="recent-movements-list"
        onClick={() => setShowRecentMovements((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          padding: "0.875rem 1rem",
          background: "none",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-md)",
          cursor: "pointer",
          minHeight: "52px",
        }}
      >
        <span className="text-body-strong" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-strong)" }}>
          {t("Recent movements", "Últimos movimientos")}
          {recentStockMovements.length > 0 && <span style={{ color: "var(--tone-muted)", fontWeight: 400 }}> ({recentStockMovements.length})</span>}
        </span>
        <div style={{
          width: "28px",
          height: "28px",
          borderRadius: "50%",
          backgroundColor: "var(--surface-subtle)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--tone-muted)",
        }}>
          {showRecentMovements ? <CaretUp size={16} aria-hidden /> : <CaretDown size={16} aria-hidden />}
        </div>
      </button>

      {showRecentMovements && recentStockMovements.length === 0 && (
        <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)", padding: "0.5rem 0" }}>
          {t("No recent movements.", "Sin movimientos recientes.")}
        </p>
      )}
      {showRecentMovements && recentStockMovements.length > 0 && (
        <div id="recent-movements-list">
          {recentStockMovements.map((movement) => (
            <div
              key={movement.id}
              className="flex items-start justify-between gap-4 py-2.5"
              style={{ borderTop: "none" }}
            >
              <div className="min-w-0">
                <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--tone-strong)", lineHeight: 1.4 }}>
                  {movement.productName}
                </p>
                <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)", marginTop: "2px" }}>
                  {movementKindLabel(movement)} · {formatTime(movement.createdAt)}
                </p>
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: movement.delta < 0 ? "var(--danger)" : "var(--success)" }}>
                  {movement.delta > 0 ? "+" : ""}{movement.delta}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
