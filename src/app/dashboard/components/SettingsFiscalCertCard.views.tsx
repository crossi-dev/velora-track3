"use client";

// SettingsFiscalCertCard.views.tsx — sub-components and styles for the ARCA
// certificate settings card. Extracted to keep the main card under 400 lines.

import type React from "react";
import { useRef, useState } from "react";
import { useT } from "../lib/DashboardLangContext";

// ── Types ─────────────────────────────────────────────────────────────────────

export type FiscalStatusResponse =
  | { connected: false }
  | {
      connected: true;
      cuit: string;
      ivaCondition: string | null;
      puntoVenta: number;
      environment: string;
    };

// ── ConnectedBody ─────────────────────────────────────────────────────────────

export interface ConnectedBodyProps {
  status: Extract<FiscalStatusResponse, { connected: true }>;
  disconnecting: boolean;
  onReplace: () => void;
  onDisconnect: () => void;
}

export function ConnectedBody({ status, disconnecting, onReplace, onDisconnect }: ConnectedBodyProps) {
  const t = useT();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <Pill tone="success" label={t("Connected", "Conectado")} />

      {/* Safe credential metadata — no passphrase, no cert path */}
      <dl style={DL_STYLE}>
        <MetaRow label={t("CUIT", "CUIT")} value={status.cuit} />
        {status.ivaCondition ? (
          <MetaRow label={t("IVA condition", "Cond. IVA")} value={status.ivaCondition} />
        ) : null}
        <MetaRow label={t("Punto de venta", "Punto de venta")} value={String(status.puntoVenta)} />
        {status.environment === "homo" ? (
          <MetaRow label={t("Environment", "Entorno")} value={t("Homologación (test)", "Homologación (test)")} />
        ) : null}
      </dl>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
        <button
          type="button"
          onClick={onReplace}
          disabled={disconnecting}
          style={secondaryButtonStyle(disconnecting)}
        >
          {t("Replace certificate", "Reemplazar certificado")}
        </button>
        <button
          type="button"
          onClick={onDisconnect}
          disabled={disconnecting}
          style={dangerButtonStyle(disconnecting)}
        >
          {disconnecting
            ? t("Disconnecting…", "Desconectando…")
            : t("Disconnect", "Desconectar")}
        </button>
      </div>
    </div>
  );
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "baseline" }}>
      <dt style={META_LABEL_STYLE}>{label}</dt>
      <dd style={META_VALUE_STYLE}>{value}</dd>
    </div>
  );
}

// ── UploadForm ────────────────────────────────────────────────────────────────

export type UploadState = "idle" | "uploading" | "success" | "error";

export interface UploadFormProps {
  fileRef: React.RefObject<HTMLInputElement | null>;
  passphraseRef: React.RefObject<HTMLInputElement | null>;
  uploadState: UploadState;
  alreadyConnected: boolean;
  onSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  onCancel?: () => void;
  t: (en: string, es: string) => string;
}

export function UploadForm({ fileRef, passphraseRef, uploadState, alreadyConnected, onSubmit, onCancel, t }: UploadFormProps) {
  const busy = uploadState === "uploading";
  const [fileName, setFileName] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  function handlePickFile() {
    fileRef.current?.click();
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setFileName(file ? file.name : null);
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {!alreadyConnected && (
        <Pill tone="warn" label={t("Not connected", "Sin certificado")} />
      )}

      <div style={LABEL_STYLE_INLINE}>
        <span style={LABEL_TEXT_STYLE}>{t("AFIP certificate", "Certificado de AFIP")}</span>
        {/* Hidden native input — triggered programmatically */}
        <input
          ref={fileRef}
          type="file"
          accept=".p12,application/x-pkcs12"
          disabled={busy}
          onChange={handleFileChange}
          style={{ display: "none" }}
          tabIndex={-1}
          aria-hidden="true"
        />
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          <button
            ref={triggerRef}
            type="button"
            disabled={busy}
            onClick={handlePickFile}
            style={secondaryButtonStyle(busy)}
          >
            {t("Choose certificate", "Elegir certificado")}
          </button>
          <span style={{ fontSize: "0.875rem", color: fileName ? "var(--tone-strong)" : "var(--tone-muted)", fontFamily: "var(--font-dm-sans)" }}>
            {fileName ?? t("No file selected", "Ningún archivo seleccionado")}
          </span>
        </div>
        <span style={{ fontSize: "0.8125rem", color: "var(--tone-muted)", marginTop: "0.125rem" }}>
          {t(
            "The file you download from the AFIP portal when you generate your digital certificate.",
            "Es el archivo que descargás desde el portal de AFIP cuando generás tu certificado digital.",
          )}
        </span>
      </div>

      <label style={LABEL_STYLE_INLINE}>
        <span style={LABEL_TEXT_STYLE}>{t("Passphrase", "Contraseña del certificado")}</span>
        <input
          ref={passphraseRef}
          type="password"
          autoComplete="new-password"
          disabled={busy}
          placeholder="••••••••"
          style={PASSPHRASE_INPUT_STYLE}
        />
      </label>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button type="submit" disabled={busy} style={primaryButtonStyle()}>
          {busy
            ? t("Uploading…", "Subiendo…")
            : alreadyConnected
              ? t("Update certificate", "Actualizar certificado")
              : t("Connect certificate", "Conectar certificado")}
        </button>
        {onCancel && (
          <button type="button" disabled={busy} onClick={onCancel} style={secondaryButtonStyle(busy)}>
            {t("Cancel", "Cancelar")}
          </button>
        )}
      </div>
    </form>
  );
}

// ── Pill ──────────────────────────────────────────────────────────────────────

export function Pill({ tone, label }: { tone: "warn" | "success"; label: string }) {
  const colors = {
    warn: { bg: "var(--warning-soft)", fg: "var(--warning)" },
    success: { bg: "var(--success-soft)", fg: "var(--success)" },
  } as const;
  const c = colors[tone];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.25rem 0.75rem",
        borderRadius: "999px",
        fontSize: "0.875rem",
        fontWeight: 600,
        backgroundColor: c.bg,
        color: c.fg,
        alignSelf: "flex-start",
      }}
    >
      {label}
    </span>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

export const MUTED_TEXT: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--tone-muted)",
  margin: 0,
  fontFamily: "var(--font-dm-sans)",
};

export const ERROR_TEXT: React.CSSProperties = {
  color: "var(--danger)",
  fontSize: "0.875rem",
  marginTop: "0.5rem",
  fontFamily: "var(--font-dm-sans)",
};

export const SUCCESS_TEXT: React.CSSProperties = {
  color: "var(--success)",
  fontSize: "0.875rem",
  marginTop: "0.5rem",
  fontFamily: "var(--font-dm-sans)",
};

const LABEL_STYLE_INLINE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
};

const LABEL_TEXT_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  color: "var(--tone-muted)",
};

const PASSPHRASE_INPUT_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "1rem",
  height: "2.5rem",
  padding: "0 0.75rem",
  borderRadius: "0.5rem",
  border: "1px solid var(--border)",
  backgroundColor: "var(--surface)",
  color: "var(--tone-strong)",
  width: "100%",
  maxWidth: "20rem",
};

const DL_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  margin: 0,
  padding: 0,
};

const META_LABEL_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.8125rem",
  fontWeight: 600,
  color: "var(--tone-muted)",
  minWidth: "9rem",
  margin: 0,
};

const META_VALUE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.875rem",
  color: "var(--tone-strong)",
  margin: 0,
};

function primaryButtonStyle(): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "2.25rem",
    padding: "0.5rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "none",
    cursor: "pointer",
    backgroundColor: "var(--tone-strong, #111827)",
    color: "var(--surface, #ffffff)",
    alignSelf: "flex-start",
  };
}

function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    minHeight: "2.25rem",
    padding: "0.5rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "1px solid var(--border, #d1d5db)",
    backgroundColor: "transparent",
    color: "var(--tone-strong, #111827)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
    alignSelf: "flex-start",
  };
}

function dangerButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    minHeight: "2.25rem",
    padding: "0.5rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "1px solid #fca5a5",
    backgroundColor: "transparent",
    color: "#dc2626",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.6 : 1,
    alignSelf: "flex-start",
  };
}
