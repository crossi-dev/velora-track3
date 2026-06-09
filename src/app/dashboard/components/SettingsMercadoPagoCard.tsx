"use client";

// Card "Mercado Pago" en Ajustes → Negocio. Lee /api/integrations/mp/status
// y muestra:
//   - "No conectado" + opciones de conexión: OAuth O token propio.
//   - "Conectado como {mpUserId}" + botón "Desconectar" si ya está enlazado.
//
// Dos caminos de conexión:
//   1. OAuth (flujo Velora, requiere MP_CLIENT_SECRET configurado).
//   2. Self-managed: el dueño pega su propio APP_USR- token de producción.
//      Este es el camino recomendado mientras el OAuth de Velora esté pendiente.
//
// TanStack Query: status is cached via useQuery so re-entering Settings is instant.
// Source: https://tanstack.com/query/latest/docs/framework/react/overview

import { useCallback, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useT } from "../lib/DashboardLangContext";
import { CARD_CLASS, CARD_STYLE, CARD_TITLE_STYLE } from "./SettingsShared";

interface MpStatus {
  configured: boolean;
  connected: boolean;
  mpUserId?: string;
  expiresAt?: string;
  liveMode?: boolean;
}

const MP_STATUS_QUERY_KEY = ["mp-status"] as const;

async function fetchMpStatus(): Promise<MpStatus> {
  const res = await fetch("/api/integrations/mp/status", { cache: "no-store" });
  if (!res.ok) throw new Error(`status ${res.status}`);
  return (await res.json()) as MpStatus;
}

export function SettingsMercadoPagoCard() {
  const t = useT();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [showTokenHelp, setShowTokenHelp] = useState(false);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  const { data: status, isLoading: loading, error: queryError } = useQuery({
    queryKey: MP_STATUS_QUERY_KEY,
    queryFn: fetchMpStatus,
  });

  // queryError surfaces if the endpoint is unreachable; local error state covers
  // user-action errors (connect/disconnect failures).
  const displayError = error ?? (queryError instanceof Error
    ? t("Could not load Mercado Pago status.", "No se pudo leer el estado de Mercado Pago.")
    : null);

  // Two-step connect: fetch the authorization URL via authenticated XHR
  // (carries x-velora-owner-token in Capacitor), then navigate to MP.
  // This avoids the broken pattern of navigating directly to /connect, which
  // can't carry custom headers and fails auth in the Capacitor Android app.
  //
  // Capacitor native (Android/iOS): MP rejects WebView UA at the OAuth login
  // page. Show a clear message instead of attempting the in-WebView redirect.
  // Full native-OAuth flow (signed state + system browser + deep link back
  // to app) is a separate work item — see engram architecture/mp-oauth-native.
  const handleConnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { isCapacitor } = await import("@/lib/capacitor-helpers");
      if (isCapacitor()) {
        setError(t(
          "Mercado Pago connection needs a web browser. Open Velora on your desktop or in Chrome on your phone and connect from here. This is a Mercado Pago security restriction.",
          "Para conectar Mercado Pago necesito un navegador web. Abrí Velora en tu computadora o en Chrome del teléfono y conectalo desde acá. Es por una restricción de seguridad de MP."
        ));
        setBusy(false);
        return;
      }
      const res = await fetch("/api/integrations/mp/connect?format=json", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as { authorizationUrl?: string; error?: string };
      if (!data.authorizationUrl) throw new Error(data.error ?? "No authorization URL returned.");
      window.location.href = data.authorizationUrl;
    } catch {
      setError(t("Could not start Mercado Pago connection. Try again.", "No se pudo iniciar la conexión con Mercado Pago. Reintentá."));
      setBusy(false);
    }
    // Note: busy stays true while navigating away — component unmounts on redirect.
  }, [t]);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const idempotencyKey = `mp-disconnect-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const res = await fetch("/api/integrations/mp/disconnect", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: "{}",
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      await queryClient.invalidateQueries({ queryKey: MP_STATUS_QUERY_KEY });
    } catch {
      setError(t("Disconnect failed. Try again.", "No se pudo desconectar. Reintentá."));
    } finally {
      setBusy(false);
    }
  }, [queryClient, t]);

  const handleConnectToken = useCallback(async () => {
    const token = tokenInput.trim();
    if (!token.startsWith("APP_USR-")) {
      setTokenError(t(
        "The token must start with APP_USR-. Make sure you copied the Production Access Token.",
        "El token debe empezar con APP_USR-. Asegurate de copiar el Access Token de Producción.",
      ));
      tokenInputRef.current?.focus();
      return;
    }
    setBusy(true);
    setTokenError(null);
    try {
      const idempotencyKey = `mp-token-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const res = await fetch("/api/integrations/mp/connect-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({ accessToken: token }),
      });
      const data = await res.json() as { ok?: boolean; message?: string; code?: string };
      if (!res.ok) {
        setTokenError(data.message ?? t("Connection failed. Try again.", "No se pudo conectar. Reintentá."));
        return;
      }
      setTokenInput("");
      await queryClient.invalidateQueries({ queryKey: MP_STATUS_QUERY_KEY });
    } catch {
      setTokenError(t("Connection failed. Try again.", "No se pudo conectar. Reintentá."));
    } finally {
      setBusy(false);
    }
  }, [tokenInput, queryClient, t]);

  // status is undefined on first load; show loading skeleton until data arrives.
  const resolvedStatus = status ?? { configured: false, connected: false };

  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      <p style={CARD_TITLE_STYLE}>{t("Mercado Pago", "Mercado Pago")}</p>
      {loading ? (
        <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0 }}>
          {t("Loading…", "Cargando…")}
        </p>
      ) : (
        <MpBody
          status={resolvedStatus}
          busy={busy}
          tokenInput={tokenInput}
          tokenError={tokenError}
          showTokenHelp={showTokenHelp}
          tokenInputRef={tokenInputRef}
          onTokenChange={setTokenInput}
          onToggleHelp={() => setShowTokenHelp((v) => !v)}
          onConnect={handleConnect}
          onConnectToken={handleConnectToken}
          onDisconnect={handleDisconnect}
        />
      )}
      {displayError ? (
        <p style={{ color: "var(--danger)", fontSize: "0.875rem", marginTop: "0.5rem" }}>
          {displayError}
        </p>
      ) : null}
    </div>
  );
}

interface MpBodyProps {
  status: MpStatus;
  busy: boolean;
  tokenInput: string;
  tokenError: string | null;
  showTokenHelp: boolean;
  tokenInputRef: React.RefObject<HTMLInputElement | null>;
  onTokenChange: (v: string) => void;
  onToggleHelp: () => void;
  onConnect: () => void;
  onConnectToken: () => void;
  onDisconnect: () => void;
}

function MpBody({
  status, busy, tokenInput, tokenError, showTokenHelp,
  tokenInputRef, onTokenChange, onToggleHelp,
  onConnect, onConnectToken, onDisconnect,
}: MpBodyProps) {
  const t = useT();

  if (status.connected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
        <Pill
          tone="success"
          label={t(`Connected as ${status.mpUserId ?? "—"}`, `Conectado como ${status.mpUserId ?? "—"}`)}
        />
        <button type="button" onClick={onDisconnect} disabled={busy} style={secondaryButtonStyle(busy)}>
          {busy ? t("Disconnecting…", "Desconectando…") : t("Disconnect", "Desconectar")}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      <Pill tone="warn" label={t("Not connected", "No conectado")} />

      {/* OAuth path (requires Velora MP app to be configured) */}
      {status.configured ? (
        <button type="button" onClick={onConnect} disabled={busy} style={primaryButtonStyle()}>
          {busy ? t("Connecting…", "Conectando…") : t("Connect Mercado Pago", "Conectar Mercado Pago")}
        </button>
      ) : null}

      {/* Divider */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
        <hr style={{ flex: 1, border: "none", borderTop: "1px solid var(--border, #d1d5db)", margin: 0 }} />
        <span style={{ fontSize: "0.875rem", color: "var(--tone-muted)", whiteSpace: "nowrap" }}>
          {status.configured
            ? t("or connect with your own access token", "o conectá con tu propio access token")
            : t("Connect with your own access token", "Conectá con tu propio access token")}
        </span>
        <hr style={{ flex: 1, border: "none", borderTop: "1px solid var(--border, #d1d5db)", margin: 0 }} />
      </div>

      {/* Self-managed token input */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
        <input
          ref={tokenInputRef}
          type="password"
          value={tokenInput}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="APP_USR-…"
          autoComplete="off"
          disabled={busy}
          style={tokenInputStyle(busy)}
        />
        {tokenError ? (
          <p style={{ fontSize: "0.875rem", color: "var(--danger)", margin: 0 }}>
            {tokenError}
          </p>
        ) : null}
        <button
          type="button"
          onClick={onConnectToken}
          disabled={busy || tokenInput.trim().length === 0}
          style={primaryButtonStyle()}
        >
          {busy ? t("Connecting…", "Conectando…") : t("Connect with token", "Conectar con token")}
        </button>

        {/* Help toggle */}
        <button
          type="button"
          onClick={onToggleHelp}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
            fontSize: "0.875rem", color: "var(--tone-accent, #2563eb)", textAlign: "left" }}
        >
          {showTokenHelp
            ? t("Hide instructions", "Ocultar instrucciones")
            : t("How to get an Access Token?", "¿Cómo conseguir un Access Token?")}
        </button>
        {showTokenHelp ? <TokenHelp /> : null}
      </div>
    </div>
  );
}

function TokenHelp() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      <a
        href="https://developers.mercadopago.com.ar"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          fontSize: "0.875rem",
          color: "var(--tone-accent, #2563eb)",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        Ir a Mercado Pago Developers →
      </a>
      <ol style={{ fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0,
        paddingLeft: "1.25rem", display: "flex", flexDirection: "column", gap: "0.25rem" }}>
        <li>Entrá con tu cuenta MP → <strong>Tus integraciones → Crear aplicación</strong>.</li>
        <li>En <strong>Credenciales de producción</strong> copiá el <strong>Access Token</strong> (empieza con <code>APP_USR-</code>).</li>
        <li>Pegalo arriba → <strong>Conectar con token</strong>.</li>
      </ol>
    </div>
  );
}

function Pill({ tone, label }: { tone: "muted" | "warn" | "success"; label: string }) {
  const colors = {
    muted: { bg: "var(--surface-muted, #f3f4f6)", fg: "var(--tone-muted, #6b7280)" },
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

function tokenInputStyle(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    boxSizing: "border-box",
    padding: "0.5rem 0.75rem",
    fontSize: "1rem",
    borderRadius: "0.375rem",
    border: "1px solid var(--border, #d1d5db)",
    backgroundColor: disabled ? "var(--surface-muted, #f3f4f6)" : "var(--surface, #ffffff)",
    color: "var(--tone-strong, #111827)",
    opacity: disabled ? 0.6 : 1,
    fontFamily: "monospace",
  };
}

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
