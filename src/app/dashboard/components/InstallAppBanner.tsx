"use client";

import { useEffect, useState } from "react";
import { X } from "@phosphor-icons/react";

// BeforeInstallPromptEvent is not in the standard TypeScript lib — declare locally.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "velora-install-banner-dismissed";
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { until: number };
    return Date.now() < parsed.until;
  } catch {
    return false;
  }
}

function markDismissed(): void {
  try {
    localStorage.setItem(DISMISS_KEY, JSON.stringify({ until: Date.now() + DISMISS_TTL_MS }));
  } catch { /* storage unavailable — ignore */ }
}

function isStandalone(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(display-mode: standalone)").matches
  );
}

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iP(hone|ad|od)/.test(ua) && /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS/.test(ua);
}

interface InstallAppBannerProps {
  /** Becomes true once the first assistant reply arrives. */
  triggered: boolean;
}

export function InstallAppBanner({ triggered }: InstallAppBannerProps) {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIosGuide, setShowIosGuide] = useState(false);
  const [visible, setVisible] = useState(false);

  // Capture the native install prompt (Chrome Android / desktop).
  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => { window.removeEventListener("beforeinstallprompt", handler); };
  }, []);

  // Decide visibility once triggered.
  useEffect(() => {
    if (!triggered) return;
    if (isStandalone()) return;
    if (isDismissed()) return;

    if (deferredPrompt) {
      setVisible(true);
    } else if (isIosSafari()) {
      setShowIosGuide(true);
      setVisible(true);
    }
    // Other browsers without beforeinstallprompt: silent — nothing to show.
  }, [triggered, deferredPrompt]);

  function handleInstall() {
    if (!deferredPrompt) return;
    void deferredPrompt.prompt();
    void deferredPrompt.userChoice.then(() => {
      setDeferredPrompt(null);
      setVisible(false);
    });
  }

  function handleDismiss() {
    markDismissed();
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      role="banner"
      aria-label="Instalar Velora"
      style={{
        background: "var(--surface)",
        borderBottom: "1px solid rgba(0,0,0,0.08)",
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        padding: "0.625rem 1rem",
        fontSize: "0.875rem",
        lineHeight: "1.4",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        {showIosGuide ? (
          <span>
            Instalá Velora: tocá{" "}
            <strong>Compartir</strong> → <strong>Agregar a inicio</strong>
          </span>
        ) : (
          <span>Instalá Velora en tu pantalla de inicio para acceso rápido.</span>
        )}
      </div>

      {!showIosGuide && (
        <button
          type="button"
          onClick={handleInstall}
          style={{
            background: "var(--brand)",
            color: "var(--accent-cream)",
            border: "none",
            borderRadius: "0.375rem",
            padding: "0.375rem 0.75rem",
            fontSize: "0.875rem",
            fontWeight: 600,
            cursor: "pointer",
            whiteSpace: "nowrap",
            flexShrink: 0,
            minHeight: "44px",
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          Instalar
        </button>
      )}

      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Cerrar"
        style={{
          background: "transparent",
          border: "none",
          cursor: "pointer",
          padding: "0.25rem",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "inherit",
          opacity: 0.6,
          minWidth: "44px",
          minHeight: "44px",
        }}
      >
        <X size={16} aria-hidden />
      </button>
    </div>
  );
}
