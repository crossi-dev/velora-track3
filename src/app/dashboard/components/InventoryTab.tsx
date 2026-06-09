"use client";

import { useCallback, useEffect, useState, useMemo, useRef } from "react";
import { MagnifyingGlassIcon, PlusIcon, WarningIcon } from "@phosphor-icons/react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { Product, StockMovement, ContactRow } from "@/domain";
import type { BusinessSummary, QuickActionMode } from "../lib/types";
import { getAppSettings } from "../lib/appSettings";
import { useDebouncedValue } from "../lib/hooks/useDebouncedValue";
import {
  buildLowStockDismissalKey,
  LOW_STOCK_DISMISSALS_STORAGE_KEY,
  parseDismissedLowStockKeys,
  pruneDismissedLowStockKeys,
} from "../lib/low-stock-dismissals";
import { RecentMovements } from "./RecentMovements";
import { ProductList } from "./ProductList";
import { ProductDetailSheet } from "./ProductDetailSheet";
import { LowStockRow } from "./LowStockRow";
import { SectionMarker } from "./v2/SectionMarker";
import { ImportButton } from "./ImportButton";
import { useRole, useBusinessActionsContext } from "../lib/contexts";

interface InventoryTabProps {
  business: BusinessSummary;
  products: Product[];
  suppliers: ContactRow[];
  onProductSaved: (id: string) => void;
  inventoryChanges: StockMovement[];
  openSellProductHelper: (productName: string) => void;
  setQuickAction: (action: QuickActionMode) => void;
  updateProduct: (id: string, patch: Partial<Product>) => void;
  deleteProduct: (id: string) => Promise<void>;
  moneyFmt: (value: unknown, currency: string) => string;
  formatDate: (value: string) => string;
  formatTime: (value: string) => string;
  t: (en: string, es: string) => string;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function InventoryTab({
  business,
  products,
  suppliers,
  onProductSaved,
  inventoryChanges,
  openSellProductHelper,
  setQuickAction,
  updateProduct,
  deleteProduct,
  moneyFmt,
  formatDate,
  formatTime,
  t,
}: InventoryTabProps) {
  const role = useRole();
  const { performImport, reloadData } = useBusinessActionsContext();
  const [reorderPickerProductId, setReorderPickerProductId] = useState<string | null>(null);
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [savingProductId, setSavingProductId] = useState<string | null>(null);
  const [errorProductId, setErrorProductId] = useState<string | null>(null);
  const productSavingRef = useRef(false);
  const [search, setSearch] = useState("");
  const [showRecentMovements, setShowRecentMovements] = useState(false);
  const [dismissedLowStockKeys, setDismissedLowStockKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!reorderPickerProductId) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(`[data-reorder-id="${reorderPickerProductId}"]`)) return;
      setReorderPickerProductId(null);
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") setReorderPickerProductId(null); };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer, { passive: true });
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [reorderPickerProductId]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const handlePointer = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest(`[data-confirm-delete-id="${confirmDeleteId}"]`)) return;
      setConfirmDeleteId(null);
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") setConfirmDeleteId(null); };
    document.addEventListener("mousedown", handlePointer);
    document.addEventListener("touchstart", handlePointer, { passive: true });
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("touchstart", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [confirmDeleteId]);

  const appPrefs = getAppSettings();
  const lowStockProducts = useMemo(
    () =>
      appPrefs.showLowStockAlerts
        ? products.filter((p) => p.stock <= appPrefs.lowStockThreshold)
        : [],
    [appPrefs.lowStockThreshold, appPrefs.showLowStockAlerts, products]
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const restoredKeys = parseDismissedLowStockKeys(
      window.localStorage.getItem(LOW_STOCK_DISMISSALS_STORAGE_KEY),
      lowStockProducts
    );

    setDismissedLowStockKeys((current) => {
      const sameSize = current.size === restoredKeys.length;
      const sameValues = sameSize && restoredKeys.every((key) => current.has(key));
      return sameValues ? current : new Set(restoredKeys);
    });
  }, [lowStockProducts]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const prunedKeys = pruneDismissedLowStockKeys(dismissedLowStockKeys, lowStockProducts);
    const sameSize = dismissedLowStockKeys.size === prunedKeys.length;
    const sameValues = sameSize && prunedKeys.every((key) => dismissedLowStockKeys.has(key));

    if (!sameValues) {
      setDismissedLowStockKeys(new Set(prunedKeys));
      return;
    }

    window.localStorage.setItem(LOW_STOCK_DISMISSALS_STORAGE_KEY, JSON.stringify(prunedKeys));
  }, [dismissedLowStockKeys, lowStockProducts]);

  const visibleLowStockProducts = useMemo(
    () => lowStockProducts.filter((product) => !dismissedLowStockKeys.has(buildLowStockDismissalKey(product))),
    [dismissedLowStockKeys, lowStockProducts]
  );

  const dismissLowStockProduct = useCallback((product: Product) => {
    const dismissalKey = buildLowStockDismissalKey(product);

    setDismissedLowStockKeys((current) => {
      if (current.has(dismissalKey)) {
        return current;
      }

      const next = new Set(current);
      next.add(dismissalKey);
      return next;
    });

    setReorderPickerProductId((current) => (current === product.id ? null : current));
  }, []);

  // Auto-dismiss removed: low-stock warnings require action and must be manually dismissed via the X button on each row.

  const recentStockMovements = inventoryChanges.slice(0, 4);

  function movementKindLabel(m: StockMovement): string {
    if (m.reason === "sale") return t("Sale", "Venta");
    if (m.reason === "import") return t("Import", "Importación");
    return t("Adjustment", "Ajuste");
  }

  const debouncedSearch = useDebouncedValue(search, 300);

  const filtered = useMemo(() => {
    if (!debouncedSearch.trim()) return products;
    const q = debouncedSearch.trim().toLowerCase();
    return products.filter((p) =>
      p.name.toLowerCase().includes(q) ||
      (p.sku ?? "").toLowerCase().includes(q)
    );
  }, [products, debouncedSearch]);

  const selectedProduct = selectedProductId ? products.find((p) => p.id === selectedProductId) : null;
  const selectedMovements = selectedProductId
    ? inventoryChanges.filter((m) => m.productId === selectedProductId)
    : [];

  return (
    <div className="flex flex-col gap-4">
      {/* v2 editorial header — section marker + Fraunces title.
          Replaces the implicit-tab-header pattern with the explicit
          mock anchor. KPI counter (products / low / out) lives inline
          to keep mobile-friendly density. */}
      <div className="flex flex-col gap-1.5">
        <SectionMarker label={t("Operations", "Operación")} number="03" />
        <h1 className="t-display-3" style={{ color: "var(--tone-strong)", margin: 0 }}>
          {t("Inventory", "Stock")}
        </h1>
        {products.length > 0 && (
          <p
            style={{
              fontFamily: "var(--font-dm-sans)",
              fontSize: "var(--caption)",
              color: "var(--tone-muted)",
              margin: "4px 0 0 0",
              letterSpacing: "var(--track-body)",
            }}
          >
            {products.length} {t("active products", "productos activos")}
            {lowStockProducts.length > 0 && (
              <>
                {" · "}
                <span style={{ color: "var(--danger)", fontWeight: 600 }}>
                  {lowStockProducts.length} {t("low stock", "con stock bajo")}
                </span>
              </>
            )}
          </p>
        )}
      </div>

      {/* v3 — search + CTA en una sola fila. El "+ Nuevo" pasa a ser
          primario (cream/navy) porque es la acción principal del tab y
          no debe competir con el banner de stock bajo. */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <MagnifyingGlassIcon className="icon-xs absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--tone-muted)" }} aria-hidden />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("Search products…", "Buscar productos…")}
            aria-label={t("Search products", "Buscar productos")}
            className="pl-9 h-10 bg-[var(--surface-subtle)] border-transparent focus-visible:border-input focus-visible:bg-background"
          />
        </div>
        {role !== "employee" && (
          <>
            <Button
              type="button"
              onClick={() => setQuickAction("product")}
              className="flex-shrink-0 gap-1.5"
              aria-label={t("New product", "Nuevo producto")}
            >
              <PlusIcon weight="bold" aria-hidden />
              {t("New", "Nuevo")}
            </Button>
            <ImportButton
              type="products"
              label={t("Import", "Importar")}
              performImport={performImport}
              onSuccess={reloadData}
            />
          </>
        )}
      </div>

      {/* v3 — banner sticky para que el aviso de stock bajo no se entierre
          al scrollear listas largas. position: sticky + top offset acomoda
          el topbar del shell (~56px). Sólo aplica si hay items visibles. */}
      {visibleLowStockProducts.length > 0 && (
        <div
          style={{
            position: "sticky",
            top: "calc(var(--app-topbar-h, 3.5rem) + 8px)",
            zIndex: 5,
            backgroundColor: "var(--danger-soft)",
            border: "1px solid var(--danger-border)",
            borderRadius: "var(--radius-md)",
            padding: "0.875rem 1rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.75rem",
            boxShadow: "0 1px 0 rgba(0,0,0,0.02), 0 6px 16px -10px rgba(0,0,0,0.12)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <WarningIcon size={16} weight="fill" style={{ color: "var(--danger)" }} aria-hidden />
            <span
              className="t-label"
              style={{ color: "var(--danger)", margin: 0 }}
            >
              {t("Low stock", "Stock bajo")}
              {visibleLowStockProducts.length > 1 && (
                <span style={{ marginLeft: 6, opacity: 0.7, fontWeight: 500 }}>
                  · {visibleLowStockProducts.length}
                </span>
              )}
            </span>
          </div>
          {visibleLowStockProducts.map((p) => (
              <LowStockRow
                key={p.id}
                product={p}
                suppliers={suppliers}
                reorderPickerProductId={reorderPickerProductId}
                setReorderPickerProductId={setReorderPickerProductId}
                onDismiss={() => dismissLowStockProduct(p)}
                t={t}
              />
            ))}
        </div>
      )}

      <RecentMovements
        recentStockMovements={recentStockMovements}
        showRecentMovements={showRecentMovements}
        setShowRecentMovements={setShowRecentMovements}
        movementKindLabel={movementKindLabel}
        formatTime={formatTime}
        t={t}
      />

      <ProductList
        products={products}
        filtered={filtered}
        appPrefsLowStockThreshold={appPrefs.lowStockThreshold}
        setSelectedProductId={setSelectedProductId}
        business={business}
        moneyFmt={moneyFmt}
        t={t}
        onAddProduct={role !== "employee" ? () => setQuickAction("product") : undefined}
      />

      {selectedProduct && (
        <ProductDetailSheet
          key={selectedProduct.id}
          product={selectedProduct}
          movements={selectedMovements}
          confirmDeleteId={confirmDeleteId}
          setConfirmDeleteId={setConfirmDeleteId}
          savingProductId={savingProductId}
          setSavingProductId={setSavingProductId}
          errorProductId={errorProductId}
          setErrorProductId={setErrorProductId}
          productSavingRef={productSavingRef}
          setSelectedProductId={setSelectedProductId}
          updateProduct={updateProduct}
          deleteProduct={deleteProduct}
          onProductSaved={onProductSaved}
          openSellProductHelper={openSellProductHelper}
          formatDate={formatDate}
          formatTime={formatTime}
          t={t}
        />
      )}
    </div>
  );
}
