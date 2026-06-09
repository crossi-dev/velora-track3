"use client";

// Vista del estado confirmed/refund de la card del Cobro QR (slice 5 + 6).
// Vive en sibling para preservar el hard limit de 300 LOC en el componente
// principal `AssistantCobroQrDraft.tsx`.
//
// Estados que renderiza:
//   - "confirmed"    → bloque cinematic "✓ $X Cobrado" con animación de entrada
//                      + CTAs "Mandar comprobante" (condicional) / "Listo".
//   - "refund-prompt" → confirmación inline "¿Devolver $X en efectivo?" +
//                       botones "Sí, devolver" / "Cancelar".
//   - "refunding"    → "Devolviendo..." (spinner).
//   - "refunded"     → "↺ Devuelto en efectivo • {fecha}".
//
// Slice 6 post-confirm CTAs live in AssistantCobroQrDraft.postconfirm.tsx.

import React, { useEffect } from "react";
import { CheckCircle, CircleNotch, ArrowUUpLeft } from "@phosphor-icons/react";
import Image from "next/image";
import type { CobroQrDraftState } from "../../lib/types";
import { PostConfirmActions } from "./AssistantCobroQrDraft.postconfirm";

interface ConfirmedViewProps {
  draft: CobroQrDraftState;
  errorMessage: string | null;
  onStartRefundPrompt: () => void;
  onConfirmRefund: () => void;
  onCancelRefundPrompt: () => void;
  onDismiss?: () => void;
  moneyFmt: (n: number) => string;
  t: (en: string, es: string) => string;
}

function formatRefundedAt(iso: string | null | undefined, locale: string): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    return d.toLocaleString(locale, {
      hour: "2-digit",
      minute: "2-digit",
      day: "2-digit",
      month: "2-digit",
    });
  } catch {
    return "";
  }
}

// Keyframes injected once via <style> tag (deduped by id).
const KEYFRAMES_ID = "cobro-confirmed-kf";
const KEYFRAMES_CSS = [
  "@keyframes cobroConfirmedIn{from{opacity:0;transform:scale(.97)}to{opacity:1;transform:scale(1)}}",
  "@keyframes cobroCheckIn{from{opacity:0;transform:scale(.6)}to{opacity:1;transform:scale(1)}}",
  "@media(prefers-reduced-motion:reduce){@keyframes cobroConfirmedIn{from{opacity:0}to{opacity:1}}",
  "@keyframes cobroCheckIn{from{opacity:0}to{opacity:1}}}",
].join("");

function InjectKeyframes() {
  // DOM mutation must happen in useEffect, not during render.
  useEffect(() => {
    if (document.getElementById(KEYFRAMES_ID)) return;
    const style = document.createElement("style");
    style.id = KEYFRAMES_ID;
    style.textContent = KEYFRAMES_CSS;
    document.head.appendChild(style);
  }, []);
  return null;
}

// ─── Component ───────────────────────────────────────────────────────────────

export function CobroConfirmedView({
  draft,
  errorMessage,
  onStartRefundPrompt,
  onConfirmRefund,
  onCancelRefundPrompt,
  onDismiss,
  moneyFmt,
  t,
}: ConfirmedViewProps) {
  const status = draft.status;

  if (status === "refunded") {
    const when = formatRefundedAt(draft.refundedAt ?? null, "es-AR");
    return (
      <div className="flex items-center gap-3" role="status" aria-live="polite">
        <ArrowUUpLeft weight="bold" className="icon-md" aria-hidden style={{ color: "var(--tone-muted)" }} />
        <p
          style={{
            fontFamily: "var(--font-dm-sans)",
            fontSize: "1rem",
            fontWeight: 700,
            color: "var(--tone-strong)",
            margin: 0,
          }}
        >
          {t(
            `Refunded in cash${when ? ` • ${when}` : ""}`,
            `Devuelto en efectivo${when ? ` • ${when}` : ""}`,
          )}
        </p>
      </div>
    );
  }

  const isPrompt = status === "refund-prompt";
  const isRefunding = status === "refunding";

  return (
    <div className="flex flex-col gap-3">
      <InjectKeyframes />

      {/* ── Cinematic confirmed block ── */}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "0.5rem",
          padding: "24px",
          borderRadius: "var(--radius-lg)",
          backgroundColor: "var(--success-soft)",
          border: "1px solid var(--success-border, color-mix(in srgb, var(--success) 20%, transparent))",
          overflow: "hidden",
          animation: "cobroConfirmedIn 300ms var(--ease-out) both",
        }}
      >
        {/* Check icon — scale-in entrance */}
        <CheckCircle
          weight="fill"
          aria-hidden
          style={{
            width: 48,
            height: 48,
            color: "var(--success)",
            animation: "cobroCheckIn 250ms var(--ease-out) both",
          }}
        />

        {/* Amount — Fraunces display */}
        <p
          style={{
            fontFamily: "var(--font-fraunces)",
            fontSize: "clamp(2rem, 8vw, 2.75rem)",
            fontWeight: 500,
            letterSpacing: "var(--track-display)",
            color: "var(--tone-strong)",
            margin: 0,
            lineHeight: 1.15,
            textAlign: "center",
          }}
        >
          {moneyFmt(draft.monto)}
        </p>

        {/* "Cobrado" label below amount */}
        <p
          className="text-caption"
          style={{
            fontFamily: "var(--font-dm-sans)",
            color: "var(--tone-muted)",
            margin: 0,
            fontSize: "0.875rem",
          }}
        >
          {t("Charged", "Cobrado")}
        </p>

        {/* Velora-mark watermark — trust signal at payment moment */}
        <Image
          src="/velora-mark.svg"
          alt=""
          aria-hidden
          width={32}
          height={32}
          style={{
            position: "absolute",
            bottom: 8,
            right: 10,
            opacity: 0.08,
            pointerEvents: "none",
            userSelect: "none",
          }}
        />
      </div>

      {errorMessage && (
        <p
          className="text-caption"
          style={{ fontFamily: "var(--font-dm-sans)", color: "var(--danger)", margin: 0 }}
        >
          {errorMessage}
        </p>
      )}

      {/* ── Slice 6: post-confirm CTAs ─────────────────────────────────── */}
      {!isPrompt && !isRefunding && draft.status === "confirmed" && (
        <PostConfirmActions draft={draft} onDismiss={onDismiss} t={t} />
      )}

      {isPrompt ? (
        <div
          className="flex flex-col gap-2 rounded-token-lg p-3"
          style={{
            backgroundColor: "var(--surface-subtle)",
            border: "1px solid var(--bubble-border)",
          }}
        >
          <p
            className="text-caption"
            style={{
              fontFamily: "var(--font-dm-sans)",
              color: "var(--tone-strong)",
              margin: 0,
              fontSize: "0.9375rem",
              fontWeight: 600,
            }}
          >
            {t(
              `Refund ${moneyFmt(draft.monto)} in cash?`,
              `¿Devolver ${moneyFmt(draft.monto)} en efectivo?`,
            )}
          </p>
          <div className="flex flex-col gap-2 md:flex-row">
            <button
              type="button"
              onClick={onConfirmRefund}
              disabled={isRefunding}
              className="text-caption flex-1 rounded-full px-4 py-2.5 font-bold disabled:opacity-50"
              style={{
                fontFamily: "var(--font-dm-sans)",
                backgroundColor: "var(--danger)",
                color: "white",
                minHeight: "44px",
                fontSize: "0.9375rem",
              }}
            >
              {t("Yes, refund", "Sí, devolver")}
            </button>
            <button
              type="button"
              onClick={onCancelRefundPrompt}
              disabled={isRefunding}
              className="text-caption flex-1 rounded-full px-4 py-2.5 font-medium disabled:opacity-50"
              style={{
                fontFamily: "var(--font-dm-sans)",
                color: "var(--tone-muted)",
                backgroundColor: "var(--surface)",
                minHeight: "44px",
                fontSize: "0.9375rem",
              }}
            >
              {t("Cancel", "Cancelar")}
            </button>
          </div>
        </div>
      ) : isRefunding ? (
        <div
          className="flex items-center gap-2"
          role="status"
          aria-live="polite"
          style={{ fontFamily: "var(--font-dm-sans)", color: "var(--tone-muted)", fontSize: "0.875rem" }}
        >
          <CircleNotch className="icon-sm animate-spin" aria-hidden />
          <span>{t("Refunding...", "Devolviendo...")}</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={onStartRefundPrompt}
          className="text-caption self-start rounded-full px-3 py-1.5 font-medium"
          style={{
            fontFamily: "var(--font-dm-sans)",
            color: "var(--tone-muted)",
            backgroundColor: "var(--surface-subtle)",
            border: "1px solid var(--bubble-border)",
            fontSize: "0.875rem",
            minHeight: "44px",
          }}
        >
          <span className="inline-flex items-center gap-1.5">
            <ArrowUUpLeft className="icon-sm" aria-hidden />
            {t("Refund", "Devolver")}
          </span>
        </button>
      )}
    </div>
  );
}
