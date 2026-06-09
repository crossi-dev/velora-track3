"use client";

// SettingsComunicacionesCard.form.tsx — ComunicacionesConnectForm + field sub-components.
// Split from SettingsComunicacionesCard.tsx to keep both files within the 400-line budget.
//
// Providers:
//   twilio_sms — accountSid + authToken + from (E.164 sender number)
//   resend     — apiKey + optional fromEmail
//   pedidosya  — apiToken

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
import type { ComunicacionesProvider } from "./SettingsComunicacionesCard";

type SaveState = "idle" | "saving" | "success" | "error";

// ── ConnectForm ───────────────────────────────────────────────────────────────

interface ComunicacionesConnectFormProps {
  provider: ComunicacionesProvider;
  alreadyConnected: boolean;
  onSaved: () => Promise<void>;
  onCancel?: () => void;
  t: (en: string, es: string) => string;
}

export function ComunicacionesConnectForm({
  provider,
  alreadyConnected,
  onSaved,
  onCancel,
  t,
}: ComunicacionesConnectFormProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const busy = saveState === "saving";

  // Twilio SMS fields
  const accountSidRef = useRef<HTMLInputElement>(null);
  const authTokenRef  = useRef<HTMLInputElement>(null);
  const fromRef       = useRef<HTMLInputElement>(null);
  // Resend fields
  const apiKeyRef     = useRef<HTMLInputElement>(null);
  const fromEmailRef  = useRef<HTMLInputElement>(null);
  // PedidosYa fields
  const apiTokenRef   = useRef<HTMLInputElement>(null);

  const clearSensitiveFields = useCallback(() => {
    if (authTokenRef.current)  authTokenRef.current.value  = "";
    if (apiKeyRef.current)     apiKeyRef.current.value     = "";
    if (apiTokenRef.current)   apiTokenRef.current.value   = "";
  }, []);

  const buildCredentials = useCallback((): Record<string, string> => {
    if (provider === "twilio_sms") {
      return {
        accountSid: accountSidRef.current?.value.trim() ?? "",
        authToken:  authTokenRef.current?.value.trim()  ?? "",
        from:       fromRef.current?.value.trim()       ?? "",
      };
    }
    if (provider === "resend") {
      const creds: Record<string, string> = {
        apiKey: apiKeyRef.current?.value.trim() ?? "",
      };
      const fromEmail = fromEmailRef.current?.value.trim();
      if (fromEmail) creds.from = fromEmail;
      return creds;
    }
    // pedidosya
    return {
      apiToken: apiTokenRef.current?.value.trim() ?? "",
    };
  }, [provider]);

  const handleSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setErrorMsg(null);

      const credentials = buildCredentials();

      if (provider === "twilio_sms") {
        if (!credentials.accountSid || !credentials.authToken || !credentials.from) {
          setErrorMsg(
            t(
              "Account SID, Auth Token, and From number are required.",
              "Account SID, Auth Token y número From son obligatorios.",
            ),
          );
          return;
        }
      } else if (provider === "resend") {
        if (!credentials.apiKey) {
          setErrorMsg(t("API key is required.", "La API key es obligatoria."));
          return;
        }
      } else if (provider === "pedidosya") {
        if (!credentials.apiToken) {
          setErrorMsg(t("API token is required.", "El API token es obligatorio."));
          return;
        }
      }

      setSaveState("saving");
      try {
        const res = await fetch("/api/integrations/comunicaciones/connect", {
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
    },
    [buildCredentials, clearSensitiveFields, onSaved, provider, t],
  );

  return (
    <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {provider === "twilio_sms" ? (
        <TwilioSmsFields
          accountSidRef={accountSidRef}
          authTokenRef={authTokenRef}
          fromRef={fromRef}
          busy={busy}
          t={t}
        />
      ) : provider === "resend" ? (
        <ResendFields
          apiKeyRef={apiKeyRef}
          fromEmailRef={fromEmailRef}
          busy={busy}
          t={t}
        />
      ) : (
        <PedidosYaFields
          apiTokenRef={apiTokenRef}
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
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            style={secondaryButtonStyle(busy)}
          >
            {t("Cancel", "Cancelar")}
          </button>
        )}
      </div>
    </form>
  );
}

// ── Twilio SMS fields ─────────────────────────────────────────────────────────

interface TwilioSmsFieldsProps {
  accountSidRef: React.RefObject<HTMLInputElement | null>;
  authTokenRef:  React.RefObject<HTMLInputElement | null>;
  fromRef:       React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  t: (en: string, es: string) => string;
}

function TwilioSmsFields({ accountSidRef, authTokenRef, fromRef, busy, t }: TwilioSmsFieldsProps) {
  return (
    <>
      <CredField
        label={t("Account SID", "Account SID")}
        inputRef={accountSidRef}
        type="text"
        disabled={busy}
        autoComplete="off"
      />
      <CredField
        label={t("Auth Token", "Auth Token")}
        inputRef={authTokenRef}
        type="password"
        disabled={busy}
        autoComplete="new-password"
      />
      <CredField
        label={t("From number (E.164, e.g. +549…)", "Número From (E.164, ej. +549…)")}
        inputRef={fromRef}
        type="text"
        disabled={busy}
        autoComplete="off"
      />
      <p style={HINT_TEXT}>
        {t(
          "Find your Account SID and Auth Token in the Twilio Console. The From number must be a Twilio number or verified sender.",
          "Encontrá tu Account SID y Auth Token en la Consola de Twilio. El número From debe ser un número de Twilio o remitente verificado.",
        )}
      </p>
    </>
  );
}

// ── Resend fields ─────────────────────────────────────────────────────────────

interface ResendFieldsProps {
  apiKeyRef:    React.RefObject<HTMLInputElement | null>;
  fromEmailRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  t: (en: string, es: string) => string;
}

function ResendFields({ apiKeyRef, fromEmailRef, busy, t }: ResendFieldsProps) {
  return (
    <>
      <CredField
        label={t("API Key", "API Key")}
        inputRef={apiKeyRef}
        type="password"
        disabled={busy}
        autoComplete="new-password"
      />
      <CredField
        label={t("From email (optional, e.g. hola@tudominio.com)", "Email From (opcional, ej. hola@tudominio.com)")}
        inputRef={fromEmailRef}
        type="text"
        disabled={busy}
        autoComplete="off"
      />
      <p style={HINT_TEXT}>
        {t(
          "Create an API key in resend.com/api-keys. The From address must be from a verified domain in your Resend account.",
          "Creá una API key en resend.com/api-keys. El email From debe pertenecer a un dominio verificado en tu cuenta de Resend.",
        )}
      </p>
    </>
  );
}

// ── PedidosYa fields ─────────────────────────────────────────────────────────

interface PedidosYaFieldsProps {
  apiTokenRef: React.RefObject<HTMLInputElement | null>;
  busy: boolean;
  t: (en: string, es: string) => string;
}

function PedidosYaFields({ apiTokenRef, busy, t }: PedidosYaFieldsProps) {
  return (
    <>
      <CredField
        label={t("API Token", "API Token")}
        inputRef={apiTokenRef}
        type="password"
        disabled={busy}
        autoComplete="new-password"
      />
      <p style={HINT_TEXT}>
        {t(
          "Obtain your API token from the PedidosYa Partner Portal. Contact your PedidosYa account manager if you do not have access.",
          "Obtené tu API token en el Portal de Partners de PedidosYa. Contactá a tu account manager de PedidosYa si no tenés acceso.",
        )}
      </p>
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
