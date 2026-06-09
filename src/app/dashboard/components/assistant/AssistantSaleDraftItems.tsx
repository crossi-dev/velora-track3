"use client";

// AssistantSaleDraftItems — mobile + desktop item-row rendering for AssistantSaleDraft.
// Extracted to keep AssistantSaleDraft.tsx under the 400-line frontend budget.

import React from "react";
import type { ParsedSale } from "@/domain";
import { buildPriceOutlierLabel } from "../../lib/price-outlier-label";
import { buildStockShortfallLabel } from "../../lib/stock-shortfall-label";

type ParsedItem = NonNullable<ParsedSale["items"]>[number];

interface SaleDraftItemsProps {
  items: ParsedItem[];
  currency: string;
  moneyFmt: (value: unknown, currency: string) => string;
  t: (en: string, es: string) => string;
}

/** Mobile-compact row list. */
function MobileItemList({ items, currency, moneyFmt, t }: SaleDraftItemsProps) {
  return (
    <div className="flex flex-col gap-1.5 md:hidden">
      {items.map((item, index) => (
        <div key={`${item.productId}-${index}`} className="flex flex-col gap-1">
          <div
            className="rounded-xl px-3 py-2 flex items-center justify-between gap-2"
            style={{ backgroundColor: "var(--surface)" }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <span className="px-1.5 py-0.5 rounded" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, fontSize: "0.9375rem", color: "var(--tone-muted)", backgroundColor: "var(--surface-subtle)" }}>
                x{item.quantity}
              </span>
              <span style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, fontSize: "0.9375rem", color: "var(--tone-strong)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.productName}
              </span>
            </div>
            <div className="flex flex-col items-end" style={{ flexShrink: 0 }}>
              <span style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, fontSize: "0.9375rem", color: "var(--tone-strong)" }}>
                {moneyFmt(item.subtotal, currency)}
              </span>
              <span style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 400, fontSize: "0.875rem", color: "var(--tone-muted)" }}>
                {moneyFmt(item.unitPrice, currency)} c/u
              </span>
            </div>
          </div>
          {item.priceOutlier && (
            <span className="text-caption px-3" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--warning)" }}>
              {buildPriceOutlierLabel(item.priceOutlier, currency)}
            </span>
          )}
          {item.stockShortfall && (
            <span className="text-caption px-3" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--warning)" }}>
              {buildStockShortfallLabel(item.stockShortfall)}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Desktop grid table. */
function DesktopItemTable({ items, currency, moneyFmt, t }: SaleDraftItemsProps) {
  return (
    <div className="hidden md:block overflow-hidden rounded-[1rem]" style={{ backgroundColor: "var(--surface)" }}>
      <div
        className="text-caption grid px-5 py-3"
        style={{
          backgroundColor: "var(--surface-subtle)",
          gridTemplateColumns: "minmax(0,1fr) 5rem 8rem 9rem",
          fontFamily: "var(--font-dm-sans)",
          fontWeight: 600,
          color: "var(--tone-muted)",
        }}
      >
        <span>{t("Product", "Producto")}</span>
        <span style={{ textAlign: "right" }}>{t("Qty.", "Cant.")}</span>
        <span style={{ textAlign: "right" }}>{t("Price", "Precio")}</span>
        <span style={{ textAlign: "right" }}>{t("Subtotal", "Subtotal")}</span>
      </div>
      {items.map((item, index) => (
        <React.Fragment key={`${item.productId}-${index}`}>
          <div
            className="grid items-center px-5 py-3.5"
            style={{
              gridTemplateColumns: "minmax(0,1fr) 5rem 8rem 9rem",
              fontFamily: "var(--font-dm-sans)",
              color: "var(--tone-strong)",
            }}
          >
            <span style={{ fontWeight: 600 }}>{item.productName}</span>
            <span style={{ textAlign: "right" }}>{item.quantity}</span>
            <span style={{ textAlign: "right" }}>{moneyFmt(item.unitPrice, currency)}</span>
            <span style={{ textAlign: "right", fontWeight: 700 }}>{moneyFmt(item.subtotal, currency)}</span>
          </div>
          {item.priceOutlier && (
            <div className="text-caption px-5 pb-2" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--warning)" }}>
              {buildPriceOutlierLabel(item.priceOutlier, currency)}
            </div>
          )}
          {item.stockShortfall && (
            <div className="text-caption px-5 pb-2" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--warning)" }}>
              {buildStockShortfallLabel(item.stockShortfall)}
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

/** Renders both mobile-compact and desktop-grid item lists. */
export function AssistantSaleDraftItems({ items, currency, moneyFmt, t }: SaleDraftItemsProps) {
  const safeItems = items ?? [];
  return (
    <div className="mt-2">
      <MobileItemList items={safeItems} currency={currency} moneyFmt={moneyFmt} t={t} />
      <DesktopItemTable items={safeItems} currency={currency} moneyFmt={moneyFmt} t={t} />
    </div>
  );
}
