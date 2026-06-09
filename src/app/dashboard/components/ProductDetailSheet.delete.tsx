"use client";

import { useState } from "react";
import { Trash as Trash2 } from "@phosphor-icons/react";
import type { Product, StockMovement } from "@/domain";
import { buildProductDeleteConfirmCopy } from "../lib/product-delete-copy";

// Delete section extracted from ProductDetailSheet to keep the parent under 300 lines.
// Rendered only for owner role — the parent guards with {!isEmployee && ...}.

export function ProductDeleteSection({
  product,
  movements,
  confirmDeleteId,
  setConfirmDeleteId,
  savingProductId,
  setSavingProductId,
  setSelectedProductId,
  deleteProduct,
  t,
}: {
  product: Product;
  movements: StockMovement[];
  confirmDeleteId: string | null;
  setConfirmDeleteId: (id: string | null) => void;
  savingProductId: string | null;
  setSavingProductId: (id: string | null) => void;
  setSelectedProductId: (id: string | null) => void;
  deleteProduct: (id: string) => Promise<void>;
  t: (en: string, es: string) => string;
}) {
  const [deleteError, setDeleteError] = useState<string | null>(null);

  return (
    <div style={{ borderTop: "1px solid var(--border)", marginTop: "16px", paddingTop: "16px" }}>
      {confirmDeleteId === product.id ? (() => {
        const hasSales = movements.some((m) => m.reason === "sale");
        const copy = buildProductDeleteConfirmCopy(hasSales);
        const messageColor = copy.neutralTone ? "var(--tone-body)" : "var(--danger)";
        const buttonColor = copy.neutralTone ? "var(--tone-strong)" : "var(--danger)";
        return (
          <div className="flex flex-col gap-1" data-confirm-delete-id={product.id}>
            <div className="flex items-center gap-2">
              <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: messageColor, flex: 1 }}>
                {t(copy.message, copy.message)}
              </p>
              <button
                type="button"
                onClick={() => {
                  setDeleteError(null);
                  setSavingProductId(product.id);
                  void (async () => {
                    try {
                      await deleteProduct(product.id);
                      // Only close the sheet after the delete succeeds
                      setSelectedProductId(null);
                    } catch (err) {
                      setDeleteError(err instanceof Error ? err.message : t("Could not delete product.", "No se pudo eliminar el producto."));
                    } finally {
                      setSavingProductId(null);
                    }
                  })();
                }}
                disabled={savingProductId === product.id}
                className="text-caption"
                style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-dm-sans)", color: buttonColor, fontWeight: 700, padding: "8px 12px" }}
              >
                {savingProductId === product.id ? "…" : t(copy.confirmLabel, copy.confirmLabel)}
              </button>
              <button
                type="button"
                onClick={() => { setConfirmDeleteId(null); setDeleteError(null); }}
                className="text-caption"
                style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-dm-sans)", padding: "8px 12px" }}
              >
                {t("Cancel", "Cancelar")}
              </button>
            </div>
            {deleteError && (
              <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)", paddingInline: "12px" }}>
                {deleteError}
              </p>
            )}
          </div>
        );
      })() : (
        <button
          type="button"
          onClick={() => { setConfirmDeleteId(product.id); setDeleteError(null); }}
          className="flex items-center gap-1.5 text-caption"
          style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--font-dm-sans)", color: "var(--danger)", padding: 0 }}
        >
          <Trash2 className="icon-xs" strokeWidth={1.8} aria-hidden />
          {t("Delete product", "Eliminar producto")}
        </button>
      )}
    </div>
  );
}
