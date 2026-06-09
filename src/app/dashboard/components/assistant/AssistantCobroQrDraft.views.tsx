"use client";

// Vistas internas de la card del Cobro QR — separadas del componente principal
// para mantener `AssistantCobroQrDraft.tsx` bajo el hard limit de 300 LOC.
//
// CobroQrView    — slice 1: QR placeholder + monto + leyenda.
// CobroAliasView — slice 2: alias MP/CVU del dueño en grande + copy + monto.
// CountdownPill  — slice 3: "Expira en 1:47" / "Expirado — generá un cobro nuevo".

import React, { useEffect } from "react";
import { Copy } from "@phosphor-icons/react";

export function CountdownPill({
  expired,
  label,
  hasTimeout,
  t,
}: {
  expired: boolean;
  label: string;
  hasTimeout: boolean;
  t: (en: string, es: string) => string;
}) {
  if (!hasTimeout) return null;
  return (
    <div
      role="status"
      aria-live={expired ? "assertive" : "polite"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        background: expired ? "var(--danger-soft)" : "var(--warning-soft)",
        border: `1px solid ${expired ? "var(--danger-border, var(--danger))" : "var(--warning-border, var(--warning))"}`,
        borderRadius: "var(--radius-pill, 999px)",
        padding: "0.25rem 0.75rem",
        fontSize: "0.875rem",
        fontWeight: 600,
        fontFamily: "var(--font-dm-sans)",
        color: expired ? "var(--danger)" : "var(--warning)",
      }}
    >
      {expired
        ? t("Expired — generate a new charge", "Expirado — generá un cobro nuevo")
        : t(`Expires in ${label}`, `Expira en ${label}`)}
    </div>
  );
}

export function CobroQrView({
  qrPlaceholderUrl,
  monto,
  customerName,
  sandbox,
  moneyFmt,
  t,
}: {
  qrPlaceholderUrl: string;
  monto: number;
  customerName?: string | null;
  sandbox?: boolean;
  moneyFmt: (n: number) => string;
  t: (en: string, es: string) => string;
}) {
  const [qrFailed, setQrFailed] = React.useState(false);

  // Clear a stale QR fallback when a new URL arrives.
  useEffect(() => {
    setQrFailed(false);
  }, [qrPlaceholderUrl]);

  return (
    <div className="flex flex-col items-center gap-3" style={{ paddingTop: "0.25rem" }}>
      {qrFailed ? (
        <div
          aria-label={t("QR not available", "QR no disponible")}
          style={{
            width: 180,
            height: 180,
            borderRadius: "var(--radius-lg)",
            background: "var(--surface-subtle)",
            border: "1px dashed var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.875rem",
            color: "var(--tone-muted)",
            fontFamily: "var(--font-dm-sans)",
            textAlign: "center",
            padding: "1rem",
          }}
        >
          {t("QR not available", "QR no disponible")}
        </div>
      ) : (
        <img
          src={qrPlaceholderUrl}
          alt={t("QR code placeholder", "Código QR")}
          width={180}
          height={180}
          onError={() => setQrFailed(true)}
          style={{
            width: 180,
            height: 180,
            borderRadius: "var(--radius-lg)",
            background: "var(--surface-subtle)",
            padding: "8px",
            objectFit: "contain",
          }}
        />
      )}
      {sandbox && (
        <div
          role="status"
          aria-label={t("Sandbox QR — does not process a real payment", "QR de sandbox — no procesa un pago real")}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            background: "var(--warning-soft, #fef3c7)",
            border: "1px solid var(--warning-border, #fbbf24)",
            borderRadius: "var(--radius-pill, 999px)",
            padding: "0.25rem 0.75rem",
            fontSize: "0.875rem",
            fontWeight: 700,
            fontFamily: "var(--font-dm-sans)",
            color: "var(--warning, #d97706)",
            letterSpacing: "0.02em",
          }}
        >
          ⚠ Sandbox
        </div>
      )}
      <p
        style={{
          fontFamily: "var(--font-fraunces, var(--font-dm-sans))",
          fontSize: "1.875rem",
          fontWeight: 700,
          color: "var(--tone-strong)",
          margin: 0,
          lineHeight: 1.1,
        }}
      >
        {moneyFmt(monto)}
      </p>
      {customerName && (
        <p
          className="text-caption"
          style={{
            fontFamily: "var(--font-dm-sans)",
            color: "var(--tone-muted)",
            margin: 0,
            textAlign: "center",
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          {t(`Customer: ${customerName}`, `Cliente: ${customerName}`)}
        </p>
      )}
      <p
        className="text-caption"
        style={{
          fontFamily: "var(--font-dm-sans)",
          color: "var(--tone-muted)",
          margin: 0,
          textAlign: "center",
          fontSize: "0.875rem",
        }}
      >
        {sandbox
          ? t(
              "Credentials not detected — this QR is for demo only and does not process a real payment.",
              "Credenciales de MercadoPago no detectadas — este QR es de sandbox y no procesa un pago real.",
            )
          : t(
              'When the customer pays, tap "Mark as charged".',
              'Cuando el cliente pague, tocá "Marcar cobrado".',
            )}
      </p>
    </div>
  );
}

export function CobroAliasView({
  alias,
  monto,
  customerName,
  aliasCopied,
  onCopy,
  moneyFmt,
  t,
}: {
  alias: string;
  monto: number;
  customerName?: string | null;
  aliasCopied: boolean;
  onCopy: () => void;
  moneyFmt: (n: number) => string;
  t: (en: string, es: string) => string;
}) {
  return (
    <div className="flex flex-col items-center gap-3" style={{ paddingTop: "0.25rem" }}>
      <p
        className="text-caption"
        style={{
          fontFamily: "var(--font-dm-sans)",
          color: "var(--tone-muted)",
          margin: 0,
          fontSize: "0.875rem",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          fontWeight: 600,
        }}
      >
        {t("Transfer to alias", "Transferí al alias")}
      </p>
      <button
        type="button"
        onClick={onCopy}
        className="flex items-center gap-2 rounded-token-lg px-4 py-3"
        style={{
          fontFamily: "var(--font-dm-sans)",
          backgroundColor: "var(--surface-subtle)",
          border: "1px solid var(--bubble-border)",
          color: "var(--tone-strong)",
          fontSize: "1.5rem",
          fontWeight: 700,
          cursor: "pointer",
          wordBreak: "break-all",
          minHeight: "52px",
        }}
        aria-label={t("Copy alias", "Copiar alias")}
      >
        <span>{alias}</span>
        <Copy className="icon-sm" aria-hidden style={{ color: "var(--tone-muted)" }} />
      </button>
      {aliasCopied && (
        <p
          className="text-caption"
          role="status"
          aria-live="polite"
          style={{
            fontFamily: "var(--font-dm-sans)",
            color: "var(--success, #22c55e)",
            margin: 0,
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          {t("Alias copied", "Alias copiado")}
        </p>
      )}
      <p
        style={{
          fontFamily: "var(--font-fraunces, var(--font-dm-sans))",
          fontSize: "1.875rem",
          fontWeight: 700,
          color: "var(--tone-strong)",
          margin: 0,
          lineHeight: 1.1,
        }}
      >
        {moneyFmt(monto)}
      </p>
      {customerName && (
        <p
          className="text-caption"
          style={{
            fontFamily: "var(--font-dm-sans)",
            color: "var(--tone-muted)",
            margin: 0,
            textAlign: "center",
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          {t(`Customer: ${customerName}`, `Cliente: ${customerName}`)}
        </p>
      )}
      <p
        className="text-caption"
        style={{
          fontFamily: "var(--font-dm-sans)",
          color: "var(--tone-muted)",
          margin: 0,
          textAlign: "center",
          fontSize: "0.875rem",
        }}
      >
        {t(
          'When the transfer arrives, tap "Mark as charged".',
          'Cuando llegue la transferencia, tocá "Marcar cobrado".',
        )}
      </p>
    </div>
  );
}
