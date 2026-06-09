"use client";

import React, { useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CaretRightIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import type { Product } from "@/domain";
import type { BusinessSummary } from "../lib/types";
import { EmptyInventoryState } from "./EmptyInventoryState";
import { SkeletonRow } from "./SkeletonRow";

type SortKey = "name-asc" | "stock-asc" | "stock-desc";

function sortProducts(products: Product[], sort: SortKey): Product[] {
  const arr = [...products];
  if (sort === "name-asc") return arr.sort((a, b) => a.name.localeCompare(b.name, "es"));
  if (sort === "stock-asc") return arr.sort((a, b) => a.stock - b.stock);
  return arr.sort((a, b) => b.stock - a.stock);
}

const ROW_HEIGHT = 72;

const PRODUCT_NAME_STYLE: CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  color: "var(--tone-strong)",
  margin: 0,
};

const PRODUCT_PRICE_STYLE: CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  color: "var(--tone-strong)",
  flexShrink: 0,
  whiteSpace: "nowrap",
};

const PRODUCT_STOCK_BASE: CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  margin: "2px 0 0",
};

const CHEVRON_STYLE: CSSProperties = { color: "var(--tone-muted)", flexShrink: 0 };
const NO_PRICE_STYLE: CSSProperties = { color: "var(--tone-muted)", fontStyle: "italic" };

const ProductRow = React.memo(function ProductRow({
  product,
  appPrefsLowStockThreshold,
  setSelectedProductId,
  business,
  moneyFmt,
  t,
}: {
  product: Product;
  appPrefsLowStockThreshold: number;
  setSelectedProductId: (id: string) => void;
  business: BusinessSummary;
  moneyFmt: (value: unknown, currency: string) => string;
  t: (en: string, es: string) => string;
}) {
  const isLowStock = product.stock <= appPrefsLowStockThreshold;
  const stockColor = product.stock === 0
    ? "var(--danger)"
    : isLowStock
    ? "var(--danger, #DC2626)"
    : "var(--success)";

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => setSelectedProductId(product.id)}
      className="list-row w-full h-auto justify-start text-left rounded-none px-0 py-0"
    >
      <div className="min-w-0 flex-1">
        <p className="text-body-strong" style={PRODUCT_NAME_STYLE}>{product.name}</p>
        <p className="text-caption" style={{ ...PRODUCT_STOCK_BASE, color: stockColor }}>
          {t("Stock", "Stock")}: {product.stock}
        </p>
      </div>
      <p className="text-caption" style={{ ...PRODUCT_PRICE_STYLE, fontWeight: 600 }}>
        {product.price != null
          ? moneyFmt(product.price, business.currency)
          : <span style={NO_PRICE_STYLE}>{t("No price", "Sin precio")}</span>
        }
      </p>
      <CaretRightIcon className="icon-sm" style={CHEVRON_STYLE} aria-hidden />
    </Button>
  );
});

export function ProductList({
  products,
  filtered,
  appPrefsLowStockThreshold,
  setSelectedProductId,
  business,
  moneyFmt,
  t,
  loading = false,
  onAddProduct,
}: {
  products: Product[];
  filtered: Product[];
  appPrefsLowStockThreshold: number;
  setSelectedProductId: (id: string) => void;
  business: BusinessSummary;
  moneyFmt: (value: unknown, currency: string) => string;
  t: (en: string, es: string) => string;
  /** When true, renders skeleton placeholders instead of the list/empty state. */
  loading?: boolean;
  onAddProduct?: () => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const [sort, setSort] = useState<SortKey>("name-asc");

  const SORT_OPTIONS: { key: SortKey; label: string }[] = [
    { key: "name-asc", label: t("Name A-Z", "Nombre A-Z") },
    { key: "stock-asc", label: t("Stock ↑", "Stock ↑") },
    { key: "stock-desc", label: t("Stock ↓", "Stock ↓") },
  ];

  const sorted = sortProducts(filtered, sort);

  const virtualizer = useVirtualizer({
    count: sorted.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  // Usage: <ProductList loading={isLoading} ... /> — shows shimmer rows while fetching.
  if (loading) {
    return <SkeletonRow count={6} />;
  }

  if (products.length === 0) {
    return <EmptyInventoryState onAddProduct={onAddProduct} />;
  }

  if (filtered.length === 0) {
    return (
      <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", textAlign: "center", padding: "2rem" }}>
        {t("No products match the search.", "No hay productos que coincidan con la búsqueda.")}
      </p>
    );
  }

  return (
    <>
      <div
        className="flex gap-1.5 flex-wrap mb-2"
        role="group"
        aria-label={t("Sort products", "Ordenar productos")}
      >
        {SORT_OPTIONS.map((opt) => (
          <Button
            key={opt.key}
            type="button"
            variant={sort === opt.key ? "default" : "outline"}
            size="sm"
            onClick={() => setSort(opt.key)}
            aria-pressed={sort === opt.key}
            className="rounded-full font-medium"
          >
            {opt.label}
          </Button>
        ))}
      </div>
      <div
        ref={parentRef}
        style={{ height: "min(60vh, 480px)", overflowY: "auto" }}
      >
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const product = sorted[virtualRow.index];
          return (
            <div
              key={product.id}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <ProductRow
                product={product}
                appPrefsLowStockThreshold={appPrefsLowStockThreshold}
                setSelectedProductId={setSelectedProductId}
                business={business}
                moneyFmt={moneyFmt}
                t={t}
              />
            </div>
          );
        })}
      </div>
    </div>
    </>
  );
}
