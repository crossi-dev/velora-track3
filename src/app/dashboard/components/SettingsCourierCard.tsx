"use client";

// Card "Courier / Logística" en Ajustes → Negocio.
//
// Shows per-provider connection status for Andreani, OCA, and Correo Argentino.
// For each provider:
//   - "Conectado" pill when a CourierCredential row exists.
//   - Collapsed connect form when not connected (expands on button click).
//   - Sensitive fields are cleared immediately after a successful save.
//
// OCA and Correo Argentino API adapters are not yet wired — the form stores
// credentials for future use and shows a "(próximamente)" label.
//
// businessId is derived from the authenticated session on the server —
// the client NEVER sends a businessId in the request body.
//
// Split: ConnectForm + field helpers live in SettingsCourierCard.form.tsx.
//
// TanStack Query: courier status is cached so re-entering Settings is instant.
// Source: https://tanstack.com/query/latest/docs/framework/react/overview

import { useCallback, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "../lib/DashboardLangContext";
import { CARD_CLASS, CARD_STYLE, CARD_TITLE_STYLE } from "./SettingsShared";
import { ConnectForm } from "./SettingsCourierCard.form";

// ── Types ────────────────────────────────────────────────────────────────────

interface CourierStatus {
  andreani: { connected: boolean };
  oca:      { connected: boolean };
  correo:   { connected: boolean };
}

type Provider = "andreani" | "oca" | "correo";

// ── Query key ────────────────────────────────────────────────────────────────

const COURIER_STATUS_QUERY_KEY = ["courier-status"] as const;

const DEFAULT_COURIER_STATUS: CourierStatus = {
  andreani: { connected: false },
  oca:      { connected: false },
  correo:   { connected: false },
};

async function fetchCourierStatus(): Promise<CourierStatus> {
  const res = await fetch("/api/integrations/logistica/status", { cache: "no-store" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as CourierStatus;
}

// ── Main card ────────────────────────────────────────────────────────────────

export function SettingsCourierCard({ restrictTo }: { restrictTo?: "andreani" | "oca" | "correo" } = {}) {
  const t = useT();
  const queryClient = useQueryClient();

  const { data: status, isLoading: loadingStatus } = useQuery({
    queryKey: COURIER_STATUS_QUERY_KEY,
    queryFn: fetchCourierStatus,
  });

  const resolvedStatus = status ?? DEFAULT_COURIER_STATUS;

  const reload = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: COURIER_STATUS_QUERY_KEY });
  }, [queryClient]);

  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      <p style={CARD_TITLE_STYLE}>{t("Logistics / Courier", "Logística / Courier")}</p>
      <p style={HINT_TEXT}>
        {t(
          "Connect your own courier account so Velora can quote and create shipments on your behalf.",
          "Conectá tu propia cuenta de courier para que Velora pueda cotizar y crear envíos en tu nombre.",
        )}
      </p>

      {loadingStatus ? (
        <p style={MUTED_TEXT}>{t("Loading…", "Cargando…")}</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {(!restrictTo || restrictTo === "andreani") && (
            <ProviderSection
              provider="andreani"
              label="Andreani"
              connected={resolvedStatus.andreani.connected}
              onSaved={reload}
              t={t}
            />
          )}
          {(!restrictTo || restrictTo === "oca") && (
            <ProviderSection
              provider="oca"
              label="OCA"
              connected={resolvedStatus.oca.connected}
              onSaved={reload}
              comingSoon
              t={t}
            />
          )}
          {(!restrictTo || restrictTo === "correo") && (
            <ProviderSection
              provider="correo"
              label="Correo Argentino"
              connected={resolvedStatus.correo.connected}
              onSaved={reload}
              comingSoon
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
  provider: Provider;
  label: string;
  connected: boolean;
  onSaved: () => Promise<void>;
  comingSoon?: boolean;
  t: (en: string, es: string) => string;
}

function ProviderSection({ provider, label, connected, onSaved, comingSoon, t }: ProviderSectionProps) {
  const [showForm, setShowForm] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handleDisconnect() {
    if (!confirm(t(
      `Remove ${label} credentials? This cannot be undone.`,
      `¿Eliminar las credenciales de ${label}? Esta acción no se puede deshacer.`,
    ))) return;

    setDisconnecting(true);
    try {
      const res = await fetch("/api/integrations/logistica/disconnect", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as Record<string, unknown>;
        alert(typeof err.message === "string" ? err.message : t("Could not disconnect.", "No se pudo desconectar."));
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
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <p style={PROVIDER_LABEL}>{label}</p>
        {comingSoon && (
          <span style={COMING_SOON_BADGE}>
            {t("coming soon", "próximamente")}
          </span>
        )}
      </div>

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
          <ConnectForm
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

const COMING_SOON_BADGE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.875rem",
  fontWeight: 500,
  color: "var(--tone-muted)",
  backgroundColor: "var(--surface-subtle)",
  border: "1px solid var(--border)",
  borderRadius: "999px",
  padding: "0.125rem 0.5rem",
  whiteSpace: "nowrap" as const,
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
