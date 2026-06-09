"use client";

// Card "Certificado ARCA" en Ajustes → Negocio → Datos fiscales y envíos.
//
// Shows the state of the owner's ARCA/AFIP .p12 certificate:
//   - "Sin certificado" + upload form if no ArcaCredential exists.
//   - "Conectado" pill + CUIT, IVA condition, punto de venta + "Desconectar"
//     button + "Reemplazar" button if a credential exists.
//
// Sub-components and styles live in SettingsFiscalCertCard.views.tsx.
// The .p12 and passphrase are NEVER shown, logged, or returned from the API.

import { useCallback, useEffect, useRef, useState } from "react";
import { useT } from "../lib/DashboardLangContext";
import { CARD_CLASS, CARD_STYLE, CARD_TITLE_STYLE } from "./SettingsShared";
import {
  ConnectedBody,
  UploadForm,
  MUTED_TEXT,
  ERROR_TEXT,
  SUCCESS_TEXT,
  type FiscalStatusResponse,
  type UploadState,
} from "./SettingsFiscalCertCard.views";

export function SettingsFiscalCertCard() {
  const t = useT();
  const [status, setStatus] = useState<FiscalStatusResponse>({ connected: false });
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [disconnecting, setDisconnecting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const passphraseRef = useRef<HTMLInputElement>(null);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch("/api/integrations/fiscal/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as FiscalStatusResponse;
      setStatus(data);
    } catch {
      // Graceful degradation — assume not connected; owner can still submit form.
      setStatus({ connected: false });
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const handleSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);

    const file = fileRef.current?.files?.[0];
    const passphrase = passphraseRef.current?.value ?? "";

    if (!file) {
      setErrorMsg(t("Select your AFIP certificate file.", "Seleccioná el certificado de AFIP."));
      return;
    }
    if (!passphrase.trim()) {
      setErrorMsg(t("Enter the certificate passphrase.", "Ingresá la contraseña del certificado."));
      return;
    }

    setUploadState("uploading");

    const body = new FormData();
    body.append("cert", file);
    body.append("passphrase", passphrase);

    try {
      const res = await fetch("/api/integrations/fiscal/connect", {
        method: "POST",
        body,
      });
      const json = (await res.json()) as { ok?: boolean; code?: string; message?: string };
      if (!res.ok) {
        setErrorMsg(json.message ?? t("Upload failed. Try again.", "Error al subir. Reintentá."));
        setUploadState("error");
        return;
      }
      setUploadState("success");
      setShowForm(false);
      // Clear sensitive fields immediately after success.
      if (fileRef.current) fileRef.current.value = "";
      if (passphraseRef.current) passphraseRef.current.value = "";
      await loadStatus();
    } catch {
      setErrorMsg(t("Network error. Check your connection.", "Error de red. Revisá tu conexión."));
      setUploadState("error");
    }
  }, [t, loadStatus]);

  const handleDisconnect = useCallback(async () => {
    const confirmed = window.confirm(
      t(
        "Remove the ARCA certificate? You will need to re-upload it to issue invoices.",
        "¿Desconectar el certificado ARCA? Vas a necesitar volver a cargarlo para emitir facturas.",
      ),
    );
    if (!confirmed) return;

    setDisconnecting(true);
    setErrorMsg(null);
    try {
      const idempotencyKey = `arca-disconnect-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const res = await fetch("/api/integrations/fiscal/disconnect", {
        method: "DELETE",
        headers: { "x-idempotency-key": idempotencyKey },
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      await loadStatus();
    } catch {
      setErrorMsg(t("Disconnect failed. Try again.", "No se pudo desconectar. Reintentá."));
    } finally {
      setDisconnecting(false);
    }
  }, [loadStatus, t]);

  return (
    <div className={CARD_CLASS} style={CARD_STYLE}>
      <p style={CARD_TITLE_STYLE}>{t("ARCA certificate", "Certificado ARCA")}</p>

      {loadingStatus ? (
        <p style={MUTED_TEXT}>{t("Loading…", "Cargando…")}</p>
      ) : status.connected && !showForm ? (
        <ConnectedBody
          status={status}
          disconnecting={disconnecting}
          onReplace={() => { setShowForm(true); setUploadState("idle"); setErrorMsg(null); }}
          onDisconnect={handleDisconnect}
        />
      ) : (
        <UploadForm
          fileRef={fileRef}
          passphraseRef={passphraseRef}
          uploadState={uploadState}
          alreadyConnected={status.connected}
          onSubmit={handleSubmit}
          onCancel={status.connected ? () => { setShowForm(false); setErrorMsg(null); } : undefined}
          t={t}
        />
      )}

      {errorMsg ? (
        <p role="alert" style={ERROR_TEXT}>{errorMsg}</p>
      ) : null}

      {uploadState === "success" && !showForm ? (
        <p style={SUCCESS_TEXT}>{t("Certificate connected.", "Certificado conectado.")}</p>
      ) : null}

      <a
        href="https://auth.afip.gob.ar/contribuyente_/login.xhtml"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          marginTop: "0.75rem",
          fontSize: "0.875rem",
          color: "var(--tone-accent, #2563eb)",
          textDecoration: "none",
          fontWeight: 600,
        }}
      >
        {t("Open ARCA / AFIP portal →", "Ir al portal ARCA / AFIP →")}
      </a>
      <p style={{ ...MUTED_TEXT, marginTop: "0.25rem" }}>
        {t(
          "In ARCA: Administrador de Relaciones → Certificados Digitales. Generate the certificate, download it and upload it here with its passphrase.",
          "En ARCA: Administrador de Relaciones → Certificados Digitales. Generá el certificado, descargalo y cargalo acá con su contraseña.",
        )}
      </p>
    </div>
  );
}
