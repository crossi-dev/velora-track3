"use client";

// Card "MODO" en Ajustes → Negocio.
// Credential fields (per MODO onboarding guide + open-source WP plugin):
//   clientId     — MODO Client ID (username)
//   clientSecret — MODO Client Secret (password)
//   storeId      — MODO Store ID
//
// States:
//   - Not connected: shows credential form.
//   - Connected: shows pill + storeId (safe to display) + Update + Disconnect buttons.

import { useCallback, useEffect, useState } from "react";
import { useT } from "../lib/DashboardLangContext";
import { CARD_CLASS, CARD_STYLE, CARD_TITLE_STYLE } from "./SettingsShared";
import { ModoBody } from "./SettingsModoCard.form";

interface ModoStatus {
  connected: boolean;
}

const initialStatus: ModoStatus = { connected: false };

export function SettingsModoCard() {
  const t = useT();
  const [status, setStatus] = useState<ModoStatus>(initialStatus);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/integrations/modo/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as ModoStatus;
      setStatus(data);
    } catch {
      setError(t("Could not load MODO status.", "No se pudo leer el estado de MODO."));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      <p style={CARD_TITLE_STYLE}>{t("MODO", "MODO")}</p>
      <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", margin: "0 0 0.75rem" }}>
        {t(
          "Accept payments via MODO — Argentina's bank-backed digital wallet. Connect with your Client ID, Client Secret, and Store ID from your MODO merchant account.",
          "Aceptá pagos con MODO — la billetera digital respaldada por los bancos argentinos. Conectate con tu Client ID, Client Secret y Store ID de tu cuenta de comercio MODO.",
        )}
      </p>
      {loading ? (
        <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0 }}>
          {t("Loading…", "Cargando…")}
        </p>
      ) : (
        <ModoBody status={status} onSaved={loadStatus} />
      )}
      {error ? (
        <p style={{ color: "var(--danger)", fontSize: "0.875rem", marginTop: "0.5rem" }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
