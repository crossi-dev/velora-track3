"use client";

import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";
import { isCapacitor } from "@/lib/capacitor-helpers";
import { overlayOpenRef } from "../lib/hooks/overlayState";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  ariaLabel: string;
  title?: string;
  children: React.ReactNode;
  /** Override max-height (default: var(--sheet-max-height)) */
  maxHeight?: string;
  /** Override bottom padding (default: safe-area-aware) */
  paddingBottom?: string;
  /** When true, track on-screen keyboard via visualViewport and shift the
   *  sheet up so inputs stay visible. Opt-in because it only matters for
   *  forms; static content sheets should leave it off. */
  trackKeyboard?: boolean;
  t: (en: string, es: string) => string;
}

export function BottomSheet({
  open,
  onClose,
  ariaLabel,
  title,
  children,
  maxHeight,
  paddingBottom,
  trackKeyboard = false,
  t,
}: BottomSheetProps) {
  const [keyboardOffset, setKeyboardOffset] = useState(0);

  useEffect(() => {
    if (!trackKeyboard || !open) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => {
      const offset = Math.max(0, window.innerHeight - vv.offsetTop - vv.height);
      setKeyboardOffset(offset);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [trackKeyboard, open]);

  // Android: sync overlay state so the global back-button handler knows
  // an overlay is open and can skip minimize/tab-switch logic.
  useEffect(() => {
    if (!isCapacitor()) return;
    overlayOpenRef.current = open;
  }, [open]);

  // Android: intercept hardware back button to close the sheet first.
  // Listener is registered only while the sheet is open and only inside
  // the Capacitor WebView — the web path is unaffected.
  // ESC on web and backdrop click are handled natively by Radix Dialog.
  useEffect(() => {
    if (!open || !isCapacitor()) return;

    let removeListener: (() => void) | undefined;

    (async () => {
      try {
        const { App } = await import("@capacitor/app");
        const listener = await App.addListener("backButton", () => {
          onClose();
        });
        removeListener = () => listener.remove();
      } catch {
        // @capacitor/app unavailable — no-op
      }
    })();

    return () => removeListener?.();
  }, [open, onClose]);

  return (
    <Sheet open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <SheetContent
        side="bottom"
        // Hide the default shadcn close button — we render our own
        // so we can use Phosphor icons + Velora's token-based styling.
        className="[&>button:first-of-type]:hidden"
        style={{
          backgroundColor: "var(--surface)",
          borderTop: "1px solid var(--border)",
          borderRadius: "var(--sheet-radius) var(--sheet-radius) 0 0",
          paddingTop: "var(--gutter-tight)",
          paddingLeft: "var(--gutter-tight)",
          paddingRight: "var(--gutter-tight)",
          paddingBottom: paddingBottom ?? "max(40px, env(safe-area-inset-bottom, 0px))",
          boxShadow: "var(--shadow-lg)",
          maxHeight: maxHeight ?? "var(--sheet-max-height)",
          overflowY: "auto",
          transform: keyboardOffset > 0 ? `translateY(-${keyboardOffset}px)` : undefined,
          transition: keyboardOffset > 0 ? "transform 120ms ease-out" : undefined,
        }}
      >
        {/* Required for Radix accessibility — visually hidden when title prop is absent */}
        <SheetTitle className="sr-only">{title ?? ariaLabel}</SheetTitle>
        <SheetDescription className="sr-only">{ariaLabel}</SheetDescription>

        {/* Drag handle — decorative only, no swipe gesture */}
        <div aria-hidden="true" style={{ display: "flex", justifyContent: "center", marginBottom: "16px" }}>
          <div
            style={{
              width: "36px",
              height: "4px",
              borderRadius: "var(--radius-pill)",
              backgroundColor: "var(--border)",
            }}
          />
        </div>

        {/* Header with optional title + close button */}
        {title ? (
          <div className="flex items-start justify-between" style={{ marginBottom: "16px" }}>
            <p
              className="text-body-strong"
              style={{
                fontFamily: "var(--font-dm-sans)",
                fontWeight: 700,
                color: "var(--tone-strong)",
                margin: 0,
              }}
            >
              {title}
            </p>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--tone-muted)",
                padding: 0,
                flexShrink: 0,
                minWidth: "44px",
                minHeight: "44px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              aria-label={t("Close", "Cerrar")}
            >
              <X size={18} strokeWidth={2} aria-hidden />
            </button>
          </div>
        ) : (
          /* No title: still show a close button in the top-right */
          <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: "8px", marginTop: "-8px" }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                background: "none",
                border: "none",
                cursor: "pointer",
                color: "var(--tone-muted)",
                padding: 0,
                flexShrink: 0,
                minWidth: "44px",
                minHeight: "44px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              aria-label={t("Close", "Cerrar")}
            >
              <X size={18} strokeWidth={2} aria-hidden />
            </button>
          </div>
        )}

        {children}
      </SheetContent>
    </Sheet>
  );
}
