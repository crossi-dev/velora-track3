"use client";

// Botón de cámara/foto para Turn 5 del onboarding del owner.
// En mobile dispara la cámara trasera vía capture="environment" (permiso
// gestionado por el browser, no necesitamos getUserMedia). En desktop
// abre el file picker de imágenes. Listener en window:velora:open-photo-picker
// permite que el supervisor abra el picker server-driven cuando el dueño
// elige "foto" en T5.

import React, { useEffect, useId, useImperativeHandle, useRef, forwardRef, useCallback } from "react";

interface AssistantPhotoButtonProps {
  onPhotoSelect: (file: File) => void;
  onPrime?: (message: string) => void;
  t: (en: string, es: string) => string;
}

export interface AssistantPhotoButtonHandle {
  openPicker: () => void;
}

export const AssistantPhotoButton = forwardRef<AssistantPhotoButtonHandle, AssistantPhotoButtonProps>(
  function AssistantPhotoButton({ onPhotoSelect, onPrime, t }, ref) {
    const inputId = useId();
    const inputRef = useRef<HTMLInputElement | null>(null);

    const primeAndOpen = useCallback(() => {
      // Per project_three_permissions_primed: prime BEFORE opening the picker
      // so the user knows why we're asking for the camera.
      onPrime?.(t(
        "I need to see your notebook or labels to extract the products.",
        "Necesito ver tu cuaderno o las etiquetas para extraer los productos.",
      ));
      // Defer the click so the prime message has a chance to render.
      setTimeout(() => inputRef.current?.click(), 50);
    }, [onPrime, t]);

    useImperativeHandle(ref, () => ({ openPicker: primeAndOpen }), [primeAndOpen]);

    // Server-driven open: supervisor responds with clientAction=open_photo_picker;
    // useAssistantStreaming dispatches the window event below.
    useEffect(() => {
      const handler = () => primeAndOpen();
      window.addEventListener("velora:open-photo-picker", handler);
      return () => window.removeEventListener("velora:open-photo-picker", handler);
    }, [primeAndOpen]);

    return (
      <>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept="image/*"
          // capture="environment" tells mobile browsers to prefer the back
          // camera; ignored on desktop, which falls back to a file picker.
          // The cast is needed because React types still mark capture as boolean | undefined.
          capture={"environment" as unknown as boolean}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onPhotoSelect(file);
            e.target.value = "";
          }}
        />
        <button
          type="button"
          onClick={primeAndOpen}
          aria-label={t("Take or upload a photo", "Sacar o subir una foto")}
          className="inline-flex h-11 w-11 items-center justify-center rounded-full transition-all duration-200"
          style={{ backgroundColor: "var(--surface-subtle)", color: "var(--tone-muted)", border: "none" }}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </button>
      </>
    );
  },
);
