"use client";

// Card "Comunicaciones e Integraciones" en Servicios / Ajustes.
//
// Shows per-provider connection status for Twilio SMS, Resend email, and PedidosYa.
// For each provider:
//   - "Conectado" pill when a BusinessChannelCredential row exists.
//   - Connect form when not connected (or when updating credentials).
//   - Sensitive fields (tokens, secrets) are cleared immediately after a successful save.
//
// businessId is derived from the authenticated session on the server —
// the client NEVER sends a businessId in the request body.
//
// Split: ConnectForm + field helpers live in SettingsComunicacionesCard.form.tsx.
//
// TanStack Query: status is cached so re-entering the panel is instant.
// Source: https://tanstack.com/query/latest/docs/framework/react/overview

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "../lib/DashboardLangContext";
import { CARD_CLASS, CARD_STYLE, CARD_TITLE_STYLE } from "./SettingsShared";
import { ComunicacionesConnectForm } from "./SettingsComunicacionesCard.form";

// ── Types ────────────────────────────────────────────────────────────────────

interface ComunicacionesStatus {
  twilio_sms: { connected: boolean };
  resend:     { connected: boolean };
  pedidosya:  { connected: boolean };
}

export type ComunicacionesProvider = "twilio_sms" | "resend" | "pedidosya";

// ── Query key ────────────────────────────────────────────────────────────────

export const COMUNICACIONES_STATUS_QUERY_KEY = ["comunicaciones-status"] as const;

const DEFAULT_STATUS: ComunicacionesStatus = {
  twilio_sms: { connected: false },
  resend:     { connected: false },
  pedidosya:  { connected: false },
};

async function fetchComunicacionesStatus(): Promise<ComunicacionesStatus> {
  const res = await fetch("/api/integrations/comunicaciones/status", { cache: "no-store" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as ComunicacionesStatus;
}

// ── Main card ────────────────────────────────────────────────────────────────

export function SettingsComunicacionesCard({
  restrictTo,
}: {
  restrictTo?: ComunicacionesProvider;
} = {}) {
  const t = useT();
  const queryClient = useQueryClient();

  const { data: status, isLoading: loadingStatus } = useQuery({
    queryKey: COMUNICACIONES_STATUS_QUERY_KEY,
    queryFn: fetchComunicacionesStatus,
  });

  const resolvedStatus = status ?? DEFAULT_STATUS;

  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: COMUNICACIONES_STATUS_QUERY_KEY });
  }, [queryClient]);

  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      <p style={CARD_TITLE_STYLE}>
        {t("Communications & Integrations", "Comunicaciones e Integraciones")}
      </p>
      <p style={HINT_TEXT}>
        {t(
          "Connect your own messaging and delivery accounts so Velora can send SMS, emails, and PedidosYa orders on your behalf.",
          "Conectá tus propias cuentas de mensajería y pedidos para que Velora pueda enviar SMS, emails y órdenes de PedidosYa en tu nombre.",
        )}
      </p>

      {loadingStatus ? (
        <p style={MUTED_TEXT}>{t("Loading…", "Cargando…")}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {(!restrictTo || restrictTo === "twilio_sms") && (
            <ProviderSection
              provider="twilio_sms"
              label="Twilio SMS"
              connected={resolvedStatus.twilio_sms.connected}
              onSaved={reload}
              t={t}
            />
          )}
          {(!restrictTo || restrictTo === "resend") && (
            <ProviderSection
              provider="resend"
              label="Resend"
              connected={resolvedStatus.resend.connected}
              onSaved={reload}
              t={t}
            />
          )}
          {(!restrictTo || restrictTo === "pedidosya") && (
            <ProviderSection
              provider="pedidosya"
              label="PedidosYa"
              connected={resolvedStatus.pedidosya.connected}
              onSaved={reload}
              t={t}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ── Per-provider section ─────────────────────────────────────────────────────

interface ProviderSectionProps {
  provider: ComunicacionesProvider;
  label: string;
  connected: boolean;
  onSaved: () => Promise<void>;
  t: (en: string, es: string) => string;
}

function ProviderSection({ provider, label, connected, onSaved, t }: ProviderSectionProps) {
  const [showForm, setShowForm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (
      !confirm(
        t(
          `Remove ${label} credentials? This cannot be undone.`,
          `¿Eliminar las credenciales de ${label}? Esta acción no se puede deshacer.`,
        ),
      )
    ) return;

    setDisconnecting(true);
    try {
      const res = await fetch("/api/integrations/comunicaciones/disconnect", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as Record<string, unknown>;
        alert(
          typeof err.message === "string"
            ? err.message
            : t("Could not disconnect.", "No se pudo desconectar."),
        );
        return;
      }
      await onSaved();
    } catch {
      alert(t("Network error. Try again.", "Error de red. Intentá de nuevo."));
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <p style={PROVIDER_LABEL}>{label}</p>

      {connected && !showForm ? (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <Pill tone="success" label={t("Connected", "Conectado")} />
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => { setShowForm(true); }}
              style={secondaryButtonStyle()}
            >
              {t("Update credentials", "Actualizar credenciales")}
            </button>
            <button
              type="button"
              onClick={() => { void handleDisconnect(); }}
              disabled={disconnecting}
              style={destructiveButtonStyle(disconnecting)}
            >
              {disconnecting ? t("Removing…", "Eliminando…") : t("Disconnect", "Desconectar")}
            </button>
          </div>
        </div>
      ) : (
        <>
          {!connected && <Pill tone="warn" label={t("Not connected", "Sin conectar")} />}
          <ComunicacionesConnectForm
            provider={provider}
            alreadyConnected={connected}
            onSaved={async () => { setShowForm(false); await onSaved(); }}
            onCancel={connected ? () => { setShowForm(false); } : undefined}
            t={t}
          />
        </>
      )}
    </div>
  );
}

// ── Pill ─────────────────────────────────────────────────────────────────────

function Pill({ tone, label }: { tone: "warn" | "success"; label: string }) {
  const colors = {
    warn:    { bg: "var(--warning-soft)", fg: "var(--warning)" },
    success: { bg: "var(--success-soft)", fg: "var(--success)" },
  } as const;
  const c = colors[tone];
  return (
    <span style={{
      display: "inline-block",
      padding: "0.25rem 0.75rem",
      borderRadius: "999px",
      fontSize: "0.875rem",
      fontWeight: 600,
      backgroundColor: c.bg,
      color: c.fg,
      alignSelf: "flex-start",
    }}>
      {label}
    </span>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const MUTED_TEXT: React.CSSProperties = {
  fontSize: "0.875rem",
  color: "var(--tone-muted)",
  margin: 0,
  fontFamily: "var(--font-dm-sans)",
};

const HINT_TEXT: React.CSSProperties = {
  ...MUTED_TEXT,
  fontStyle: "italic",
};

const PROVIDER_LABEL: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "1rem",
  fontWeight: 600,
  color: "var(--tone-strong)",
  margin: 0,
};

function secondaryButtonStyle(): React.CSSProperties {
  return {
    minHeight: "2.25rem",
    padding: "0.5rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "1px solid var(--border, #d1d5db)",
    backgroundColor: "transparent",
    color: "var(--tone-strong, #111827)",
    cursor: "pointer",
    alignSelf: "flex-start",
  };
}

function destructiveButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    minHeight: "2.25rem",
    padding: "0.5rem 1rem",
    fontSize: "1rem",
    fontWeight: 600,
    borderRadius: "0.5rem",
    border: "1px solid #fca5a5",
    backgroundColor: "transparent",
    color: disabled ? "#9ca3af" : "#dc2626",
    cursor: disabled ? "not-allowed" : "pointer",
    alignSelf: "flex-start",
    opacity: disabled ? 0.6 : 1,
  };
}
