"use client";

import { useState, useEffect } from "react";
import { WhatsappLogo, X } from "@phosphor-icons/react";
import Image from "next/image";

interface SuccessBannerProps {
  notice: string;
  pin: string | null;
  loginUrl: string | null;
  onDismiss?: () => void;
  t: (en: string, es: string) => string;
}

const bannerStyles = `
  @keyframes velora-banner-in {
    from { opacity: 0; transform: scale(0.95); }
    to   { opacity: 1; transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    @keyframes velora-banner-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
  }

  .velora-success-banner {
    animation: velora-banner-in 250ms var(--ease-spring, cubic-bezier(0.34, 1.56, 0.64, 1)) both;
  }
`;

export function TeamSuccessBanner({ notice, pin, loginUrl, onDismiss, t }: SuccessBannerProps) {
  const [copied, setCopied] = useState(false);
  const [pinHidden, setPinHidden] = useState(false);

  useEffect(() => {
    if (!pin) return;
    const timer = window.setTimeout(() => setPinHidden(true), 60_000);
    return () => window.clearTimeout(timer);
  }, [pin]);

  const shareText = loginUrl && pin
    ? `Entrá a Velora con este link:\n${loginUrl}\n\nTu PIN: ${pin}`
    : loginUrl ?? "";

  const waMessage = loginUrl && pin
    ? `Hola! Acá tenés tu acceso a Velora: ${loginUrl}\n\nTu PIN es: ${pin}`
    : loginUrl
      ? `Hola! Acá tenés tu acceso a Velora: ${loginUrl}`
      : "";

  const handleShareWhatsApp = () => {
    if (!loginUrl) return;
    window.open(`https://wa.me/?text=${encodeURIComponent(waMessage)}`, "_blank");
  };

  const handleShare = async () => {
    if (!loginUrl) return;
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({ title: "Your Velora access", text: shareText });
        return;
      } catch { /* user cancelled or not supported */ }
    }
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt(t("Copy manually:", "Copiá manualmente:"), shareText);
    }
  };

  const employeeName = notice.match(/[""]([^""]+)[""]/)?.[1] ?? null;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: bannerStyles }} />
      <div
        role="status"
        aria-live="polite"
        className="velora-success-banner"
        style={{
          padding: "var(--space-6, 1.5rem)",
          background: "var(--success-soft)",
          border: "1px solid var(--success-border, color-mix(in srgb, var(--success) 25%, transparent))",
          borderRadius: "var(--radius-xl, 20px)",
          fontSize: "0.875rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        {/* Header row: velora mark + heading + dismiss */}
        <div style={{ display: "flex", alignItems: "flex-start", gap: "0.625rem" }}>
          <Image
            src="/velora-mark.svg"
            alt=""
            aria-hidden
            width={24}
            height={24}
            style={{ flexShrink: 0, marginTop: "2px" }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{
              margin: 0,
              color: "var(--success)",
              fontWeight: 700,
              fontSize: "1rem",
              lineHeight: 1.3,
            }}>
              {t("New employee on board!", "¡Nuevo empleado a bordo!")}
            </p>
            {loginUrl && (
              <p style={{
                margin: "0.25rem 0 0",
                color: "var(--tone-muted)",
                fontSize: "0.875rem",
                lineHeight: 1.5,
              }}>
                {employeeName
                  ? t(
                      `Share access with ${employeeName}. Velora will guide them through the chat.`,
                      `Compartí el acceso con ${employeeName}. Velora se encarga de enseñarle a usar el chat.`,
                    )
                  : t(
                      "Share access with the new employee. Velora will guide them through the chat.",
                      "Compartí el acceso. Velora se encarga de enseñarle a usar el chat.",
                    )
                }
              </p>
            )}
            <p style={{ margin: "0.125rem 0 0", color: "var(--tone-muted)", fontSize: "0.875rem" }}>{notice}</p>
          </div>
          {onDismiss && (
            <button
              type="button"
              onClick={onDismiss}
              aria-label={t("Close", "Cerrar")}
              style={{
                minWidth: "44px",
                minHeight: "44px",
                border: "none",
                background: "transparent",
                color: "var(--tone-muted)",
                cursor: "pointer",
                borderRadius: "8px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <X size={18} />
            </button>
          )}
        </div>

        {/* PIN row */}
        {pin && (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <span style={{ color: "var(--tone-muted)" }}>{t("PIN:", "PIN:")}</span>
              {pinHidden ? (
                <span style={{ fontFamily: "var(--font-dm-sans, sans-serif)", fontSize: "0.875rem", color: "var(--tone-muted)", fontStyle: "italic" }}>
                  {t("PIN hidden", "PIN oculto")}
                </span>
              ) : (
                <>
                  <span style={{
                    fontFamily: "var(--font-fraunces)",
                    fontSize: "clamp(1.5rem, 5vw, 2rem)",
                    fontWeight: 500,
                    letterSpacing: "var(--track-display, 0.02em)",
                    color: "var(--tone-strong)",
                  }}>
                    {pin}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPinHidden(true)}
                    style={{
                      minWidth: "44px",
                      minHeight: "44px",
                      border: "none",
                      background: "transparent",
                      color: "var(--tone-muted)",
                      cursor: "pointer",
                      borderRadius: "8px",
                      fontSize: "0.875rem",
                      fontWeight: 600,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      whiteSpace: "nowrap",
                    }}
                    aria-label={t("Hide PIN", "Ocultar PIN")}
                  >
                    {t("Hide PIN", "Ocultar PIN")}
                  </button>
                </>
              )}
            </div>
            <p style={{ margin: 0, fontSize: "0.875rem", color: "var(--tone-muted)", fontStyle: "italic" }}>
              {t(
                "Write it down or share it now — this PIN can be revealed one more time from the Team section.",
                "Anotalo o compartilo ahora — este PIN se puede ver una vez más desde la sección Equipo.",
              )}
            </p>
          </div>
        )}

        {/* Share row */}
        {loginUrl && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <code style={{ wordBreak: "break-all", flex: "1 1 auto", fontSize: "0.875rem", color: "var(--tone-muted)" }}>{loginUrl}</code>
            <button
              type="button"
              onClick={handleShare}
              style={{
                padding: "6px 14px",
                borderRadius: "999px",
                border: "1px solid var(--success)",
                background: copied ? "var(--success)" : "transparent",
                color: copied ? "white" : "var(--success)",
                fontSize: "0.875rem",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              {copied ? t("Copied!", "¡Copiado!") : t("Send to employee", "Mandar al empleado")}
            </button>
            <button
              type="button"
              aria-label="Compartir credenciales por WhatsApp"
              onClick={handleShareWhatsApp}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "0 16px",
                minHeight: "44px",
                minWidth: "44px",
                borderRadius: "999px",
                border: "none",
                background: "#25D366",
                color: "white",
                fontSize: "0.875rem",
                fontWeight: 600,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              <WhatsappLogo size={18} weight="fill" />
              {t("Share via WhatsApp", "Compartir por WhatsApp")}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
