"use client";

// Menú estilo WhatsApp para el botón paperclip del input bar.
// Tres opciones: Cámara (capture=environment), Galería (image/*) y Archivo
// (xlsx/csv/pdf/docx). Reemplaza al ex-AssistantPhotoButton: el flujo de
// foto del onboarding ahora vive acá adentro y comparte el mismo prime
// message. Escucha "velora:open-photo-picker" para que el supervisor
// (Turn 5 onboarding) pueda abrir la cámara server-driven.

import React, {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  AssistantAttachMenuItem,
  type AttachMenuOption,
} from "./AssistantAttachMenuItem";

interface AssistantAttachMenuProps {
  onFileSelect?: (file: File) => void;
  onPhotoSelect?: (file: File) => void;
  /** Called when the camera captures a photo for the customer list (T12). */
  onCustomerPhotoSelect?: (file: File) => void;
  onPhotoPrime?: (message: string) => void;
  t: (en: string, es: string) => string;
}

const PHOTO_PRIME_EN =
  "I need to see your notebook or labels to extract the products.";
const PHOTO_PRIME_ES =
  "Necesito ver tu cuaderno o las etiquetas para extraer los productos.";

// eslint-disable-next-line max-lines-per-function -- popover composition root
export function AssistantAttachMenu({
  onFileSelect,
  onPhotoSelect,
  onCustomerPhotoSelect,
  onPhotoPrime,
  t,
}: AssistantAttachMenuProps) {
  const menuId = useId();
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Dedicated hidden camera input for customer-photo flow (T12). Separate from
  // cameraInputRef so product and customer captures never share state.
  const customerCameraInputRef = useRef<HTMLInputElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const visibleItems: AttachMenuOption[] = [];
  if (onPhotoSelect) visibleItems.push("camera", "gallery");
  if (onFileSelect) visibleItems.push("file");

  const closeMenu = useCallback(() => {
    setOpen(false);
    setActiveIndex(0);
  }, []);

  const openCamera = useCallback(() => {
    onPhotoPrime?.(t(PHOTO_PRIME_EN, PHOTO_PRIME_ES));
    // Defer the click so the prime message has a chance to render before
    // the OS permission modal stacks on top of it.
    setTimeout(() => cameraInputRef.current?.click(), 50);
  }, [onPhotoPrime, t]);

  const openCustomerCamera = useCallback(() => {
    onPhotoPrime?.(t(
      "I need to see your customer list to extract the contacts.",
      "Necesito ver tu lista de clientes para extraer los contactos.",
    ));
    setTimeout(() => customerCameraInputRef.current?.click(), 50);
  }, [onPhotoPrime, t]);

  const openGallery = useCallback(() => {
    onPhotoPrime?.(t(PHOTO_PRIME_EN, PHOTO_PRIME_ES));
    setTimeout(() => galleryInputRef.current?.click(), 50);
  }, [onPhotoPrime, t]);

  const openFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleSelect = useCallback(
    (option: AttachMenuOption) => {
      closeMenu();
      if (option === "camera") openCamera();
      else if (option === "gallery") openGallery();
      else openFile();
    },
    [closeMenu, openCamera, openGallery, openFile],
  );

  // Server-driven open from supervisor T5/T12: treat as "camera direct" so
  // the dueño doesn't have to navigate the menu when they already picked "foto".
  // context "customers" routes to onCustomerPhotoSelect; default is products.
  useEffect(() => {
    if (!onPhotoSelect && !onCustomerPhotoSelect) return;
    const handler = (e: Event) => {
      const context = (e as CustomEvent<{ context?: string }>).detail?.context ?? "products";
      closeMenu();
      if (context === "customers" && onCustomerPhotoSelect) {
        // Swap the camera input's onChange to the customer handler for this capture.
        // We re-use the same camera input by temporarily overriding onPhotoSelect
        // isn't ideal. Instead, we open a dedicated hidden input for customers.
        openCustomerCamera();
      } else {
        openCamera();
      }
    };
    window.addEventListener("velora:open-photo-picker", handler);
    return () =>
      window.removeEventListener("velora:open-photo-picker", handler);
  }, [onPhotoSelect, onCustomerPhotoSelect, closeMenu, openCamera, openCustomerCamera]);

  // Same pattern for the Excel/CSV file picker — supervisor emits
  // velora:open-file-picker when the dueño picks "archivo" in the T5 menu.
  useEffect(() => {
    if (!onFileSelect) return;
    const handler = () => {
      closeMenu();
      openFile();
    };
    window.addEventListener("velora:open-file-picker", handler);
    return () =>
      window.removeEventListener("velora:open-file-picker", handler);
  }, [onFileSelect, closeMenu, openFile]);

  // Click outside / Esc dismiss.
  useEffect(() => {
    if (!open) return;
    const handlePointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }
      closeMenu();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeMenu();
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open, closeMenu]);

  // Focus the active item when the menu opens or activeIndex changes.
  useEffect(() => {
    if (!open) return;
    const el = itemRefs.current[activeIndex];
    el?.focus();
  }, [open, activeIndex]);

  const handleMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (visibleItems.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % visibleItems.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(
        (i) => (i - 1 + visibleItems.length) % visibleItems.length,
      );
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(visibleItems.length - 1);
    }
  };

  // Bail out si no hay nada que adjuntar — evita un ícono no-op en
  // contextos employee/companion.
  if (visibleItems.length === 0) return null;

  return (
    <div style={{ position: "relative" }}>
      {/* Hidden inputs — refs trigger them programmatically. */}
      {onPhotoSelect && (
        <>
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            // capture="environment" tells mobile browsers to prefer the
            // back camera. Ignored on desktop (falls back to file picker).
            // The cast is needed because React types still mark capture
            // as boolean | undefined.
            capture={"environment" as unknown as boolean}
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPhotoSelect(file);
              e.target.value = "";
            }}
          />
          <input
            ref={galleryInputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onPhotoSelect(file);
              e.target.value = "";
            }}
          />
        </>
      )}
      {/* Dedicated hidden camera input for T12 customer-photo flow. */}
      {onCustomerPhotoSelect && (
        <input
          ref={customerCameraInputRef}
          type="file"
          accept="image/*"
          capture={"environment" as unknown as boolean}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onCustomerPhotoSelect(file);
            e.target.value = "";
          }}
        />
      )}
      {onFileSelect && (
        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx,.csv,.pdf,.docx"
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFileSelect(file);
            e.target.value = "";
          }}
        />
      )}

      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={t("Attach", "Adjuntar")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className="inline-flex h-11 w-11 items-center justify-center rounded-full transition-all duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
        style={{
          backgroundColor: "var(--surface-subtle)",
          color: "var(--tone-muted)",
          border: "none",
          outlineColor: "var(--brand)",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          className="h-5 w-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>

      {open && (
        <div
          id={menuId}
          ref={menuRef}
          role="menu"
          aria-label={t("Attach options", "Opciones para adjuntar")}
          onKeyDown={handleMenuKeyDown}
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            left: 0,
            zIndex: "var(--z-tooltip)" as unknown as number,
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-lg)",
            boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
            padding: "6px",
            minWidth: "200px",
            display: "flex",
            flexDirection: "column",
            gap: "2px",
          }}
        >
          {visibleItems.map((option, idx) => (
            <AssistantAttachMenuItem
              key={option}
              ref={(el) => {
                itemRefs.current[idx] = el;
              }}
              option={option}
              t={t}
              onSelect={() => handleSelect(option)}
              onHover={() => setActiveIndex(idx)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
