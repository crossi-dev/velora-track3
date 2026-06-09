"use client";

// SettingsCourierCard.form.tsx — ConnectForm + field sub-components.
// Split from SettingsCourierCard.tsx to keep both files within the 400-line budget.
//
// Correo Argentino credentials: username + password only.
// customerId is resolved by the server's preflight (POST /Users/validate)
// and injected automatically — the owner never types it.

import { useCallback, useRef, useState } from "react";
import {
  HINT_TEXT,
  ERROR_TEXT,
  LABEL_STYLE_BLOCK,
  LABEL_TEXT_STYLE,
  CRED_INPUT_STYLE,
  primaryButtonStyle,
  secondaryButtonStyle,
} from "./SettingsCourierCard.styles";

type Provider = "andreani" | "oca" | "correo";
type SaveState = "idle" | "saving" | "success" | "error";

// ── ConnectForm ───────────────────────────────────────────────────────────────

interface ConnectFormProps {
  provider: Provider;
  alreadyConnected: boolean;
  onSaved: () => Promise<void>;
  onCancel?: () => void;
  t: (en: string, es: string) => string;
}

export function ConnectForm({ provider, alreadyConnected, onSaved, onCancel, t }: ConnectFormProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const busy = saveState === "saving";

  // Andreani fields
  const clientIdRef     = useRef<HTMLInputElement>(null);
  const clientSecretRef = useRef<HTMLInputElement>(null);
  const contratoDomRef  = useRef<HTMLInputElement>(null);
  const contratoSucRef  = useRef<HTMLInputElement>(null);
  const contratoExpRef  = useRef<HTMLInputElement>(null);
  // OCA fields
  const ocaUsuarioRef   = useRef<HTMLInputElement>(null);
  const ocaPasswordRef  = useRef<HTMLInputElement>(null);
  const ocaCuitRef      = useRef<HTMLInputElement>(null);
  const ocaOperativaRef = useRef<HTMLInputElement>(null);
  const ocaNroCuentaRef = useRef<HTMLInputElement>(null);
  // Correo Argentino fields
  const correoUsernameRef = useRef<HTMLInputElement>(null);
  const correoPasswordRef = useRef<HTMLInputElement>(null);

  const clearSensitiveFields = useCallback(() => {
    if (clientSecretRef.current)   clientSecretRef.current.value   = "";
    if (contratoDomRef.current)    contratoDomRef.current.value    = "";
    if (contratoSucRef.current)    contratoSucRef.current.value    = "";
    if (contratoExpRef.current)    contratoExpRef.current.value    = "";
    if (ocaPasswordRef.current)    ocaPasswordRef.current.value    = "";
    if (correoPasswordRef.current) correoPasswordRef.current.value = "";
  }, []);

  const buildCredentials = useCallback((): Record<string, string> | null => {
    if (provider === "andreani") {
      return {
        clientId:          clientIdRef.current?.value.trim()     ?? "",
        clientSecret:      clientSecretRef.current?.value.trim() ?? "",
        contratoDomicilio: contratoDomRef.current?.value.trim()  ?? "",
        contratoSucursal:  contratoSucRef.current?.value.trim()  ?? "",
        contratoExpress:   contratoExpRef.current?.value.trim()  ?? "",
      };
    }
    if (provider === "oca") {
      return {
        usuario:   ocaUsuarioRef.current?.value.trim()   ?? "",
        password:  ocaPasswordRef.current?.value.trim()  ?? "",
        cuit:      ocaCuitRef.current?.value.trim()      ?? "",
        operativa: ocaOperativaRef.current?.value.trim() ?? "",
        nroCuenta: ocaNroCuentaRef.current?.value.trim() ?? "",
      };
    }
    // Correo Argentino
    return {
      username: correoUsernameRef.current?.value.trim() ?? "",
      password: correoPasswordRef.current?.value.trim() ?? "",
    };
  }, [provider]);

  const handleSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);

    const credentials = buildCredentials();
    if (!credentials) {
      const msg =
        provider === "andreani"
          ? t("Fill in all Andreani credential fields.", "Completá todos los campos de credenciales Andreani.")
          : provider === "oca"
            ? t("Fill in all OCA credential fields.", "Completá todos los campos de credenciales OCA.")
            : t("Fill in all Correo Argentino credential fields.", "Completá todos los campos de credenciales Correo Argentino.");
      setErrorMsg(msg);
      return;
    }
    // Correo: require both username and password before submitting.
    if (provider === "correo") {
      const c = credentials as Record<string, string>;
      if (!c.username || !c.password) {
        setErrorMsg(t(
          "Username and password are required for Correo Argentino.",
          "Usuario y contraseña son obligatorios para Correo Argentino.",
        ));
        return;
      }
    }

    setSaveState("saving");
    try {
      const res = await fetch("/api/integrations/logistica/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, credentials }),
      });
      const json = (await res.json()) as { ok?: boolean; code?: string; message?: string };
      if (!res.ok) {
        setErrorMsg(json.message ?? t("Save failed. Try again.", "Error al guardar. Reintentá."));
        setSaveState("error");
        return;
      }
      setSaveState("success");
      clearSensitiveFields();
      await onSaved();
    } catch {
      setErrorMsg(t("Network error. Check your connection.", "Error de red. Revisá tu conexión."));
      setSaveState("error");
    }
  }, [buildCredentials, clearSensitiveFields, onSaved, provider, t]);

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {provider === "andreani" ? (
        <AndreaniFields
          clientIdRef={clientIdRef}
          clientSecretRef={clientSecretRef}
          contratoDomRef={contratoDomRef}
          contratoSucRef={contratoSucRef}
          contratoExpRef={contratoExpRef}
          busy={busy}
          t={t}
        />
      ) : provider === "oca" ? (
        <OcaFields
          usuarioRef={ocaUsuarioRef}
          passwordRef={ocaPasswordRef}
          cuitRef={ocaCuitRef}
          operativaRef={ocaOperativaRef}
          nroCuentaRef={ocaNroCuentaRef}
          busy={busy}
          t={t}
        />
      ) : (
        <CorreoFields
          usernameRef={correoUsernameRef}
          passwordRef={correoPasswordRef}
          busy={busy}
          t={t}
        />
      )}

      {errorMsg ? <p role="alert" style={ERROR_TEXT}>{errorMsg}</p> : null}

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button type="submit" disabled={busy} style={primaryButtonStyle()}>
          {busy
            ? t("Saving…", "Guardando…")
            : alreadyConnected
              ? t("Update", "Actualizar")
              : t("Connect", "Conectar")}
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

// ── Andreani-specific fields ─────────────────────────────────────────────────

interface AndreaniFieldsProps {
  clientIdRef:     React.RefObject<HTMLInputElement | null>;
  clientSecretRef: React.RefObject<HTMLInputElement | null>;
  contratoDomRef:  React.RefObject<HTMLInputElement | null>;
  contratoSucRef:  React.RefObject<HTMLInputElement | null>;
  contratoExpRef:  React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  t: (en: string, es: string) => string;
}

function AndreaniFields({
  clientIdRef, clientSecretRef, contratoDomRef, contratoSucRef, contratoExpRef, busy, t,
}: AndreaniFieldsProps) {
  return (
    <>
      <CredField label={t("Client ID", "Client ID")} inputRef={clientIdRef}
        type="text" disabled={busy} autoComplete="off" />
      <CredField label={t("Client Secret", "Client Secret")} inputRef={clientSecretRef}
        type="password" disabled={busy} autoComplete="new-password" />
      <CredField label={t("Contract — Home delivery", "Contrato — Domicilio")}
        inputRef={contratoDomRef} type="text" disabled={busy} autoComplete="off" />
      <CredField label={t("Contract — Branch pickup", "Contrato — Sucursal")}
        inputRef={contratoSucRef} type="text" disabled={busy} autoComplete="off" />
      <CredField label={t("Contract — Express", "Contrato — Express")}
        inputRef={contratoExpRef} type="text" disabled={busy} autoComplete="off" />
      <p style={HINT_TEXT}>
        {t(
          "Contract codes are provided by Andreani when your commercial account is activated.",
          "Los códigos de contrato te los da Andreani cuando activan tu cuenta comercial.",
        )}
      </p>
    </>
  );
}

// ── OCA-specific fields ──────────────────────────────────────────────────────

interface OcaFieldsProps {
  usuarioRef:   React.RefObject<HTMLInputElement | null>;
  passwordRef:  React.RefObject<HTMLInputElement | null>;
  cuitRef:      React.RefObject<HTMLInputElement | null>;
  operativaRef: React.RefObject<HTMLInputElement | null>;
  nroCuentaRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  t: (en: string, es: string) => string;
}

function OcaFields({
  usuarioRef, passwordRef, cuitRef, operativaRef, nroCuentaRef, busy, t,
}: OcaFieldsProps) {
  return (
    <>
      <CredField label={t("OCA User (usuario e-Pak)", "Usuario OCA (e-Pak)")}
        inputRef={usuarioRef} type="text" disabled={busy} autoComplete="username" />
      <CredField label={t("Password", "Contraseña")}
        inputRef={passwordRef} type="password" disabled={busy} autoComplete="new-password" />
      <CredField label={t("CUIT (e.g. 20-12345678-9)", "CUIT (ej. 20-12345678-9)")}
        inputRef={cuitRef} type="text" disabled={busy} autoComplete="off" />
      <CredField label={t("Operativa (contract code)", "Operativa (código de contrato)")}
        inputRef={operativaRef} type="text" disabled={busy} autoComplete="off" />
      <CredField label={t("Account number (nroCuenta)", "Número de cuenta (nroCuenta)")}
        inputRef={nroCuentaRef} type="text" disabled={busy} autoComplete="off" />
      <p style={HINT_TEXT}>
        {t(
          "Your OCA e-Pak account credentials. The operativa and account number are provided by OCA when your commercial account is activated.",
          "Credenciales de tu cuenta OCA e-Pak. La operativa y el número de cuenta te los da OCA cuando activan tu cuenta comercial.",
        )}
      </p>
    </>
  );
}

// ── Correo Argentino fields ──────────────────────────────────────────────────

interface CorreoFieldsProps {
  usernameRef: React.RefObject<HTMLInputElement | null>;
  passwordRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  t: (en: string, es: string) => string;
}

function CorreoFields({ usernameRef, passwordRef, busy, t }: CorreoFieldsProps) {
  return (
    <>
      <a
        href="https://www.correoargentino.com.ar/MiCorreo"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.25rem",
          fontSize: "0.875rem",
          color: "var(--tone-accent, #2563eb)",
          textDecoration: "none",
          fontWeight: 500,
        }}
      >
        {t("Open MiCorreo →", "Abrir MiCorreo →")}
      </a>
      <CredField
        label={t("MiCorreo email / username", "Email / usuario de MiCorreo")}
        inputRef={usernameRef}
        type="text"
        disabled={busy}
        autoComplete="username"
      />
      <CredField
        label={t("Password", "Contraseña")}
        inputRef={passwordRef}
        type="password"
        disabled={busy}
        autoComplete="new-password"
      />
    </>
  );
}

// ── Field helper ─────────────────────────────────────────────────────────────

interface CredFieldProps {
  label: string;
  inputRef: React.RefObject<HTMLInputElement | null>;
  type: "text" | "password";
  disabled: boolean;
  autoComplete: string;
}

function CredField({ label, inputRef, type, disabled, autoComplete }: CredFieldProps) {
  return (
    <label style={LABEL_STYLE_BLOCK}>
      <span style={LABEL_TEXT_STYLE}>{label}</span>
      <input
        ref={inputRef}
        type={type}
        disabled={disabled}
        autoComplete={autoComplete}
        style={CRED_INPUT_STYLE}
      />
    </label>
  );
}

