"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { X } from "@phosphor-icons/react";
import type { Product, ContactRow } from "@/domain";
import { navigateFromUserAction } from "../lib/navigate";

export const SWIPE_THRESHOLD = 80;

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function LowStockRow({
  product,
  suppliers,
  reorderPickerProductId,
  setReorderPickerProductId,
  onDismiss,
  t,
}: {
  product: Product;
  suppliers: ContactRow[];
  reorderPickerProductId: string | null;
  setReorderPickerProductId: (id: string | null) => void;
  onDismiss: () => void;
  t: (en: string, es: string) => string;
}) {
  const [reorderNotice, setReorderNotice] = useState<string | null>(null);

  function sendReorder(p: Product, supplier: ContactRow) {
    setReorderNotice(null);
    const phone = supplier.phone?.replace(/\D/g, "") ?? "";
    if (!phone) {
      setReorderNotice(t("This supplier has no WhatsApp phone number.", "Ese proveedor no tiene teléfono para WhatsApp."));
      return;
    }
    const contact = supplier.contactName ?? supplier.name;
    const msg = `Hola ${contact}, necesito reponer *${p.name}*. Stock actual: ${p.stock} u. ¿Tenés disponibilidad?`;
    if (!navigateFromUserAction(`https://wa.me/${phone}?text=${encodeURIComponent(msg)}`)) {
      setReorderNotice(t("Could not open WhatsApp.", "No pude abrir WhatsApp."));
      return;
    }
    setReorderNotice(t("Opening WhatsApp…", "Abriendo WhatsApp..."));
    setReorderPickerProductId(null);
  }
  const rowRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef<number | null>(null);
  const currentXRef = useRef(0);
  const swipeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (swipeTimerRef.current) clearTimeout(swipeTimerRef.current);
      if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
    };
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    startXRef.current = e.touches[0].clientX;
    currentXRef.current = 0;
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (startXRef.current === null) return;
    const dx = e.touches[0].clientX - startXRef.current;
    if (dx >= 0) { currentXRef.current = 0; if (rowRef.current) rowRef.current.style.transform = ""; return; }
    currentXRef.current = dx;
    if (rowRef.current) rowRef.current.style.transform = `translateX(${dx}px)`;
  }, []);

  const onTouchEnd = useCallback(() => {
    if (currentXRef.current < -SWIPE_THRESHOLD) {
      if (rowRef.current) {
        rowRef.current.style.transition = "transform 200ms ease-out, opacity 200ms ease-out";
        rowRef.current.style.transform = "translateX(-100%)";
        rowRef.current.style.opacity = "0";
      }
      swipeTimerRef.current = setTimeout(() => onDismiss(), 200);
    } else if (rowRef.current) {
      rowRef.current.style.transition = "transform 150ms ease-out";
      rowRef.current.style.transform = "";
      transitionTimerRef.current = setTimeout(() => { if (rowRef.current) rowRef.current.style.transition = ""; }, 150);
    }
    startXRef.current = null;
    currentXRef.current = 0;
  }, [onDismiss]);

  return (
    <div
      ref={rowRef}
      className="low-stock-highlight"
      style={{ touchAction: "pan-y", padding: "0.75rem 1rem", borderBottom: "1px solid var(--border)" }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600, color: "var(--tone-strong)" }}>
            {product.name}
          </p>
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", color: "var(--warning)" }}>
            {product.stock === 0
              ? t("Out of stock", "Sin stock")
              : t(`${product.stock} units left`, `${product.stock} unidades restantes`)}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {suppliers.length > 0 ? (
            <button
              type="button"
              data-reorder-id={product.id}
              onClick={() => setReorderPickerProductId(
                reorderPickerProductId === product.id ? null : product.id
              )}
              className="text-caption inline-flex items-center justify-center rounded-token-md border px-3 py-2 font-semibold flex-shrink-0"
              style={{
                minHeight: "44px",
                color: "var(--warning)",
                borderColor: "var(--danger-border)",
                backgroundColor: "var(--danger-soft)",
              }}
            >
              {t("Restock", "Reponer")}
            </button>
          ) : (
            <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", flexShrink: 0 }}>
              {t("No suppliers added", "Sin proveedores cargados")}
            </p>
          )}
          <button
            type="button"
            onClick={onDismiss}
            aria-label={t("Dismiss", "Descartar")}
            className="inline-flex items-center justify-center rounded-pill active:scale-90"
            style={{ minWidth: "44px", minHeight: "44px", width: "44px", height: "44px", color: "var(--danger)", backgroundColor: "var(--danger-soft)", border: "none", cursor: "pointer" }}
          >
            <X className="icon-xs" strokeWidth={2.5} aria-hidden />
          </button>
        </div>
      </div>

      {reorderPickerProductId === product.id && (
        <div className="mt-2 flex flex-col gap-1.5 animate-fadeUp" data-reorder-id={product.id}>
          <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", fontWeight: 600 }}>
            {t("Send via WhatsApp to:", "Enviar por WhatsApp a:")}
          </p>
          {suppliers.map((supplier) => (
            <button
              key={supplier.id}
              type="button"
              onClick={() => sendReorder(product, supplier)}
              disabled={!supplier.phone}
              className="text-caption w-full text-left rounded-token-md border px-3 py-2 font-semibold disabled:opacity-40"
              style={{
                minHeight: "44px",
                backgroundColor: "var(--surface)",
                color: "var(--tone-strong)",
                borderColor: "var(--border)",
              }}
            >
              <span style={{ fontWeight: 600 }}>{supplier.name}</span>
              {supplier.contactName && (
                <span style={{ color: "var(--tone-muted)" }}> · {supplier.contactName}</span>
              )}
              {!supplier.phone && (
                <span className="text-caption" style={{ color: "var(--tone-muted)" }}>
                  {" "}— {t("no phone", "sin teléfono")}
                </span>
              )}
            </button>
          ))}
          {reorderNotice && (
            <p className="text-caption" style={{ fontFamily: "var(--font-dm-sans)", marginTop: "4px" }}>
              {reorderNotice}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
