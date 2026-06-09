"use client";

// SettingsModoCard.form.tsx — ModoBody credential form + shared styles.
// Extracted from SettingsModoCard.tsx to keep that file under the 400-line budget.

import { useCallback, useState } from "react";
import { useT } from "../lib/DashboardLangContext";

interface ModoStatus {
  connected: boolean;
}

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

export const labelStyle: React.CSSProperties = {
  fontSize: "0.875rem",
  fontWeight: 600,
  color: "var(--tone-strong, #111827)",
};

export const inputStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "1rem",
  padding: "0.5rem 0.75rem",
  border: "1px solid var(--border, #d1d5db)",
  borderRadius: "0.375rem",
  backgroundColor: "var(--surface)",
  color: "var(--tone-strong, #111827)",
  boxSizing: "border-box",
};

export function primaryButtonStyle(): React.CSSProperties {
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

export function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
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

export function dangerButtonStyle(disabled: boolean): React.CSSProperties {
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

// ── ModoBody ──────────────────────────────────────────────────────────────────

interface ModoBodyProps {
  status: ModoStatus;
  onSaved: () => Promise<void>;
}

export function ModoBody({ status, onSaved }: ModoBodyProps) {
  const t = useT();
  const [showForm, setShowForm] = useState(!status.connected);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [storeId, setStoreId] = useState("");
  const [busy, setBusy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const handleSubmit = useCallback(async () => {
    setFormError(null);
    setSaved(false);

    const cleanClientId = clientId.trim();
    const cleanClientSecret = clientSecret.trim();
    const cleanStoreId = storeId.trim();

    if (!cleanClientId) {
      setFormError(t("Client ID is required.", "El Client ID es obligatorio."));
      return;
    }
    if (!cleanClientSecret) {
      setFormError(t("Client Secret is required.", "El Client Secret es obligatorio."));
      return;
    }
    if (!cleanStoreId) {
      setFormError(t("Store ID is required.", "El Store ID es obligatorio."));
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/integrations/modo/connect", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          credentials: {
            clientId: cleanClientId,
            clientSecret: cleanClientSecret,
            storeId: cleanStoreId,
          },
        }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? `status ${res.status}`);
      }
      setSaved(true);
      setClientId("");
      setClientSecret("");
      setStoreId("");
      setShowForm(false);
      await onSaved();
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : t("Could not save credentials. Try again.", "No se pudo guardar las credenciales. Reintentá."),
      );
    } finally {
      setBusy(false);
    }
  }, [clientId, clientSecret, storeId, t, onSaved]);

  const handleDisconnect = useCallback(async () => {
    setFormError(null);
    setDisconnecting(true);
    try {
      const res = await fetch("/api/integrations/modo/disconnect", {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? `status ${res.status}`);
      }
      await onSaved();
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : t("Could not disconnect MODO. Try again.", "No se pudo desconectar MODO. Reintentá."),
      );
    } finally {
      setDisconnecting(false);
    }
  }, [t, onSaved]);

  if (!showForm && status.connected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <Pill tone="success" label={t("Connected", "Conectado")} />
        <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0 }}>
          {t(
            "MODO is connected. Payment links are live.",
            "MODO está conectado. Los links de pago están activos.",
          )}
        </p>
        {formError ? (
          <p style={{ color: "var(--danger)", fontSize: "0.875rem", margin: 0 }}>
            {formError}
          </p>
        ) : null}
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={() => { setShowForm(true); setSaved(false); }}
            style={secondaryButtonStyle(false)}
          >
            {t("Update credentials", "Actualizar credenciales")}
          </button>
          <button
            type="button"
            onClick={() => { void handleDisconnect(); }}
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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {!status.connected && (
        <Pill tone="warn" label={t("Not connected", "No conectado")} />
      )}
      {saved && (
        <p style={{ fontSize: "0.875rem", color: "var(--success)", margin: 0 }}>
          {t("Credentials saved and verified successfully.", "Credenciales guardadas y verificadas correctamente.")}
        </p>
      )}

      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={labelStyle}>
          {t("Client ID", "Client ID")}
        </span>
        <input
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={t("Your MODO Client ID", "Tu Client ID de MODO")}
          autoComplete="off"
          style={inputStyle}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={labelStyle}>
          {t("Client Secret", "Client Secret")}
        </span>
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={t("Your MODO Client Secret", "Tu Client Secret de MODO")}
          autoComplete="new-password"
          style={inputStyle}
        />
      </label>

      <label style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <span style={labelStyle}>
          {t("Store ID", "Store ID")}
        </span>
        <input
          type="text"
          value={storeId}
          onChange={(e) => setStoreId(e.target.value)}
          placeholder={t("Your MODO Store ID", "Tu Store ID de MODO")}
          autoComplete="off"
          style={inputStyle}
        />
        <span style={{ fontSize: "0.8125rem", color: "var(--tone-muted)", fontStyle: "italic" }}>
          {t(
            "Get your credentials from the MODO merchant dashboard.",
            "Obtené tus credenciales desde el panel de comercio de MODO.",
          )}
        </span>
      </label>

      {formError ? (
        <p style={{ color: "var(--danger)", fontSize: "0.875rem", margin: 0 }}>
          {formError}
        </p>
      ) : null}

      <div style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          onClick={() => { void handleSubmit(); }}
          disabled={busy || !clientId.trim() || !clientSecret.trim() || !storeId.trim()}
          style={primaryButtonStyle()}
        >
          {busy
            ? t("Verifying…", "Verificando…")
            : t("Save and verify", "Guardar y verificar")}
        </button>
        {status.connected && (
          <button
            type="button"
            onClick={() => { setShowForm(false); setFormError(null); }}
            style={secondaryButtonStyle(busy)}
          >
            {t("Cancel", "Cancelar")}
          </button>
        )}
      </div>
    </div>
  );
}
