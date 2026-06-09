"use client";

// Card de confirmación para productos extraídos por Gemini Pro Vision desde
// la foto del cuaderno o etiquetas (Turn 5 onboarding). El dueño puede
// editar nombre y precio inline y confirmar la batch. Patrón visual
// similar a AssistantSaleDraft.tsx — sin agregar dependencias.

import React from "react";
import { CircleNotch } from "@phosphor-icons/react";
import type { PhotoProduct } from "../../lib/hooks/usePhotoExtract";
import { Button } from "@/components/ui/button";

interface AssistantPhotoProductDraftProps {
  products: PhotoProduct[];
  setProducts: (next: PhotoProduct[] | null) => void;
  loading: boolean;
  error: string | null;
  handleConfirm: () => void;
  handleDismiss: () => void;
  t: (en: string, es: string) => string;
}

export function AssistantPhotoProductDraft({
  products, setProducts, loading, error, handleConfirm, handleDismiss, t,
}: AssistantPhotoProductDraftProps) {
  const updateField = (idx: number, field: "name" | "price" | "stock", rawValue: string) => {
    const next = [...products];
    const current = { ...next[idx] };
    if (field === "name") {
      current.name = rawValue;
    } else {
      const cleaned = rawValue.replace(/[^\d.]/g, "");
      const parsed = cleaned ? Number(cleaned) : null;
      current[field] = parsed !== null && Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }
    next[idx] = current;
    setProducts(next);
  };
  const removeRow = (idx: number) => {
    const next = products.filter((_, i) => i !== idx);
    setProducts(next.length > 0 ? next : null);
  };

  return (
    <div style={{ borderRadius: "var(--radius-xl)", overflow: "hidden", backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}>
      <div className="p-4 md:p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <span style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, fontSize: "1rem", color: "var(--tone-strong)" }}>
            {t(`${products.length} products from your photo`, `${products.length} producto${products.length === 1 ? "" : "s"} de tu foto`)}
          </span>
          <span style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.875rem", color: "var(--tone-muted)" }}>
            {t("Edit before saving", "Editá antes de guardar")}
          </span>
        </div>

        <div className="flex flex-col gap-2">
          {products.map((p, idx) => (
            <div key={idx} className="rounded-xl px-3 py-2" style={{ backgroundColor: "var(--surface-subtle)" }}>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={p.name}
                  onChange={(e) => updateField(idx, "name", e.target.value)}
                  disabled={loading}
                  placeholder={t("Product name", "Nombre del producto")}
                  className="flex-1 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
                  style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", fontWeight: 600, color: "var(--tone-strong)", backgroundColor: "transparent", border: "none", minWidth: 0 }}
                />
                <Button
                  type="button"
                  onClick={() => removeRow(idx)}
                  disabled={loading}
                  aria-label={t("Remove", "Quitar")}
                  variant="ghost"
                  size="sm"
                  style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px", minWidth: "44px" }}
                >
                  {t("Remove", "Quitar")}
                </Button>
              </div>
              <div className="flex items-center gap-2 mt-1">
                <label className="flex items-center gap-1" style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.875rem", color: "var(--tone-muted)" }}>
                  <span aria-hidden>$</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={p.price !== null ? String(p.price) : ""}
                    onChange={(e) => updateField(idx, "price", e.target.value)}
                    disabled={loading}
                    placeholder="0"
                    aria-label={t("Unit price", "Precio unitario")}
                    className="outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
                    style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", color: "var(--tone-strong)", backgroundColor: "transparent", border: "none", width: "5rem" }}
                  />
                </label>
                <label className="flex items-center gap-1" style={{ fontFamily: "var(--font-dm-sans)", fontSize: "0.875rem", color: "var(--tone-muted)" }}>
                  <span aria-hidden>{t("stock", "stock")}</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={p.stock !== null ? String(p.stock) : ""}
                    onChange={(e) => updateField(idx, "stock", e.target.value)}
                    disabled={loading}
                    placeholder="0"
                    aria-label={t("Stock quantity", "Cantidad en stock")}
                    className="outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--brand)]"
                    style={{ fontFamily: "var(--font-dm-sans)", fontSize: "1rem", color: "var(--tone-strong)", backgroundColor: "transparent", border: "none", width: "4rem" }}
                  />
                </label>
              </div>
            </div>
          ))}
        </div>

        {error && (
          <p className="text-caption mt-3" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)" }}>{error}</p>
        )}

        <div className="mt-4 flex flex-col gap-2">
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={loading || products.length === 0}
            className="w-full rounded-full"
            style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px" }}
          >
            {loading
              ? <><CircleNotch className="icon-sm animate-spin" aria-hidden />{" "}{t("Saving...", "Guardando...")}</>
              : t(`Save ${products.length} products`, `Guardar ${products.length} producto${products.length === 1 ? "" : "s"}`)}
          </Button>
          <Button
            type="button"
            onClick={handleDismiss}
            disabled={loading}
            variant="ghost"
            className="w-full rounded-full"
            style={{ fontFamily: "var(--font-dm-sans)", minHeight: "44px" }}
          >
            {t("Cancel", "Cancelar")}
          </Button>
        </div>
      </div>
    </div>
  );
}
