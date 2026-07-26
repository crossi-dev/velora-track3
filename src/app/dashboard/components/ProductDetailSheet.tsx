"use client";

import { useState } from "react";
import type { Product, StockMovement } from "@/domain";
import { ProductDeleteSection } from "./ProductDetailSheet.delete";
import { BottomSheet } from "./BottomSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LABEL_STYLE, LABEL_TEXT_STYLE } from "./form-field-styles";

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function ProductDetailSheet({
  product,
  movements,
  confirmDeleteId,
  setConfirmDeleteId,
  savingProductId,
  setSavingProductId,
  errorProductId,
  setErrorProductId,
  productSavingRef,
  setSelectedProductId,
  updateProduct,
  deleteProduct,
  onProductSaved,
  openSellProductHelper,
  formatDate,
  formatTime,
  t,
}: {
  product: Product;
  movements: StockMovement[];
  confirmDeleteId: string | null;
  setConfirmDeleteId: (id: string | null) => void;
  savingProductId: string | null;
  setSavingProductId: (id: string | null) => void;
  errorProductId: string | null;
  setErrorProductId: (id: string | null) => void;
  productSavingRef: React.MutableRefObject<boolean>;
  setSelectedProductId: (id: string | null) => void;
  updateProduct: (id: string, patch: Partial<Product>) => Promise<void> | void;
  deleteProduct: (id: string) => Promise<void>;
  onProductSaved: (id: string) => void;
  openSellProductHelper: (productName: string) => void;
  formatDate: (value: string) => string;
  formatTime: (value: string) => string;
  t: (en: string, es: string) => string;
}) {
  const [nameVal, setNameVal] = useState(product.name);
  const [stockVal, setStockVal] = useState(String(product.stock));
  const [priceVal, setPriceVal] = useState(String(product.price));
  const [costPriceVal, setCostPriceVal] = useState(product.costPrice != null ? String(product.costPrice) : "");
  const [skuVal, setSkuVal] = useState(product.sku ?? "");
  const [weightGramsVal, setWeightGramsVal] = useState(product.weightGrams != null ? String(product.weightGrams) : "");
  const [nameError, setNameError] = useState<string | null>(null);
  const [stockError, setStockError] = useState<string | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);

  const isSaving = savingProductId === product.id;

  async function handleSave() {
    if (isSaving || productSavingRef.current) return;

    // Validate name
    if (!nameVal.trim()) {
      setNameError(t("Product name is required.", "El nombre del producto es obligatorio."));
      return;
    }
    setNameError(null);

    // Validate stock
    const nextStock = parseInt(stockVal, 10);
    if (stockVal === "" || !Number.isInteger(nextStock) || nextStock < 0) {
      setStockError(t("Stock must be a whole number ≥ 0.", "El stock debe ser un número entero ≥ 0."));
      return;
    }
    setStockError(null);

    // Validate price
    const nextPrice = parseFloat(priceVal);
    if (priceVal === "" || !Number.isFinite(nextPrice) || nextPrice < 0) {
      setPriceError(t("Price must be a number ≥ 0.", "El precio debe ser un número ≥ 0."));
      return;
    }
    setPriceError(null);

    // Build patch with only changed fields
    const patch: Partial<Product> = {};
    if (nameVal.trim() !== product.name) patch.name = nameVal.trim();
    if (nextStock !== product.stock) patch.stock = nextStock;
    if (nextPrice !== product.price) patch.price = nextPrice;
    const nextSku = skuVal.trim() || null;
    if (nextSku !== (product.sku ?? null)) patch.sku = nextSku ?? undefined;
    const nextCostPrice = costPriceVal !== "" && Number.isFinite(Number(costPriceVal))
      ? Number(costPriceVal)
      : null;
    if (nextCostPrice !== (product.costPrice ?? null)) patch.costPrice = nextCostPrice ?? undefined;
    const nextWeightGrams = weightGramsVal !== "" && Number.isInteger(Number(weightGramsVal)) && Number(weightGramsVal) > 0
      ? Number(weightGramsVal)
      : null;
    if (nextWeightGrams !== (product.weightGrams ?? null)) patch.weightGrams = nextWeightGrams;

    if (Object.keys(patch).length === 0) return;

    productSavingRef.current = true;
    setSavingProductId(product.id);
    setErrorProductId(null);
    try {
      await updateProduct(product.id, patch);
      onProductSaved(product.id);
    } catch {
      setErrorProductId(product.id);
    } finally {
      productSavingRef.current = false;
      setSavingProductId(null);
    }
  }

  return (
    <BottomSheet
      open
      onClose={() => setSelectedProductId(null)}
      ariaLabel={product.name}
      title={product.name}
      t={t}
    >
      <div className="flex flex-col gap-2 mb-4">
        <label style={LABEL_STYLE}>
          <span style={LABEL_TEXT_STYLE}>{t("Product name", "Nombre del producto")}</span>
          <Input
            value={nameVal}
            onChange={(e) => { setNameVal(e.target.value); setNameError(null); }}
            disabled={isSaving}
            className="font-semibold"
            aria-required="true"
          />
        </label>
        {nameError && (
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)" }}>{nameError}</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label style={LABEL_STYLE}>
            <span style={LABEL_TEXT_STYLE}>{t("Stock", "Stock")}</span>
            <Input
              type="number"
              inputMode="numeric"
              min="0"
              value={stockVal}
              onChange={(e) => { setStockVal(e.target.value); setStockError(null); }}
              disabled={isSaving}
            />
            <span style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.75rem", color: "var(--tone-muted)", marginTop: "2px" }}>
              {t("Direct adjustment — no movement recorded", "Ajuste directo — no registra movimiento")}
            </span>
          </label>
          <label style={LABEL_STYLE}>
            <span style={LABEL_TEXT_STYLE}>{t("Price", "Precio")}</span>
            <div className="relative">
              <span style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--tone-muted)", fontSize: "0.875rem", pointerEvents: "none", userSelect: "none" }}>$</span>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={priceVal}
                onChange={(e) => { setPriceVal(e.target.value); setPriceError(null); }}
                disabled={isSaving}
                className="pl-6"
              />
            </div>
          </label>
        </div>
        {(stockError ?? priceError) && (
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)" }}>
            {stockError ?? priceError}
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <label style={LABEL_STYLE}>
            <span style={LABEL_TEXT_STYLE}>SKU</span>
            <Input
              value={skuVal}
              onChange={(e) => setSkuVal(e.target.value)}
              disabled={isSaving}
              placeholder="SKU"
              className="text-muted-foreground"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <label style={LABEL_STYLE}>
            <span style={LABEL_TEXT_STYLE}>{t("Cost", "Costo")}</span>
            <div className="relative">
              <span style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--tone-muted)", fontSize: "0.875rem", pointerEvents: "none", userSelect: "none" }}>$</span>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={costPriceVal}
                onChange={(e) => setCostPriceVal(e.target.value)}
                disabled={isSaving}
                placeholder="0.00"
                className="pl-6"
              />
            </div>
          </label>
        </div>
        <label style={LABEL_STYLE}>
          <span style={LABEL_TEXT_STYLE}>
            {t("Weight in grams (optional)", "Peso en gramos (opcional)")}
          </span>
          <div className="relative">
            <Input
              type="number"
              inputMode="numeric"
              min="1"
              step="1"
              value={weightGramsVal}
              onChange={(e) => setWeightGramsVal(e.target.value)}
              disabled={isSaving}
              placeholder={t("e.g. 250", "ej. 250")}
              className="pr-8"
            />
            <span style={{ position: "absolute", right: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--tone-muted)", fontSize: "0.875rem", pointerEvents: "none", userSelect: "none" }}>g</span>
          </div>
        </label>

        <Button
          type="button"
          onClick={() => void handleSave()}
          disabled={isSaving}
          className="mt-1 w-full"
        >
          {isSaving ? t("Saving…", "Guardando…") : t("Save changes", "Guardar cambios")}
        </Button>

        {savingProductId !== product.id && errorProductId === product.id && (
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)" }}>
            {t("Error saving", "Error al guardar")}
          </p>
        )}

        <button
          type="button"
          onClick={() => openSellProductHelper(product.name)}
          className="text-caption self-start rounded-pill px-4 py-2 font-semibold"
          style={{ fontFamily: "var(--font-dm-sans)", backgroundColor: "var(--action-primary-bg)", color: "var(--action-primary-fg)" }}
        >
          {t("Sell", "Vender")}
        </button>
      </div>

      <div className="flex items-baseline justify-between mb-2">
        <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 700 }}>
          {t("Inventory history", "Historial de inventario")}
        </p>
        <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)" }}>
          {t("recent only", "solo recientes")}
        </p>
      </div>
      {movements.length === 0 ? (
        <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)" }}>
          {t("No recent movements recorded.", "No hay movimientos recientes registrados.")}
        </p>
      ) : (
        movements.map((m, index) => (
          <div
            key={m.id}
            className="flex items-center justify-between gap-4 py-2.5"
            style={{ borderTop: index === 0 ? "none" : "1px solid var(--border)" }}
          >
            <div className="min-w-0">
              <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-strong)" }}>
                {m.reason === "sale"
                  ? t("Sale", "Venta")
                  : m.reason === "import"
                  ? t("Import", "Importación")
                  : t("Manual adjustment", "Ajuste manual")}
              </p>
              <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", marginTop: "1px" }}>
                {formatDate(m.createdAt)} · {formatTime(m.createdAt)}
              </p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: m.delta < 0 ? "var(--danger)" : "var(--success)" }}>
                {m.delta > 0 ? "+" : ""}{m.delta}
              </p>
              <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)" }}>
                {m.quantityBefore} → {m.quantityAfter}
              </p>
            </div>
          </div>
        ))
      )}

      <ProductDeleteSection
        product={product}
        movements={movements}
        confirmDeleteId={confirmDeleteId}
        setConfirmDeleteId={setConfirmDeleteId}
        savingProductId={savingProductId}
        setSavingProductId={setSavingProductId}
        setSelectedProductId={setSelectedProductId}
        deleteProduct={deleteProduct}
        t={t}
      />
    </BottomSheet>
  );
}
