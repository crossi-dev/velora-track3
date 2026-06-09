"use client";

// Inline "Conectar servicio" modal for ServiciosTab.
// Opens when the user clicks a service node in the diagram.
// Embeds the matching Settings card (which owns all form state,
// validation, and API calls). ESC, focus-trap, body scroll-lock, and
// backdrop click are handled by shadcn Dialog (Radix under the hood).

import { useCallback, useState } from "react";
import type { ProviderStatus } from "./ServiciosTab.cards";
import { SettingsMercadoPagoCard } from "./SettingsMercadoPagoCard";
import { SettingsModoCard } from "./SettingsModoCard";
import { SettingsFiscalCertCard } from "./SettingsFiscalCertCard";
import { SettingsCourierCard } from "./SettingsCourierCard";
import { SettingsComunicacionesCard } from "./SettingsComunicacionesCard";
import { WhatsAppBusinessForm } from "./ServiciosTab.whatsapp-form";
import { executeDashboardAction } from "../lib/actions/executeDashboardAction";
import { useT } from "../lib/DashboardLangContext";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// ─── Alias inline form ────────────────────────────────────────────────────────

interface AliasFormProps {
  currentAlias?: string;
}

function AliasForm({ currentAlias }: AliasFormProps) {
  const t = useT();
  const alreadyConnected = !!(currentAlias && currentAlias.trim().length > 0);
  const [value, setValue] = useState(currentAlias ?? "");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const handleSave = useCallback(async () => {
    const alias = value.trim();
    if (!alias) {
      setNotice({ kind: "err", text: t("Enter an alias.", "Ingresá un alias.") });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await executeDashboardAction("business.update", { alias });
      setNotice({ kind: "ok", text: t("Alias saved.", "Alias guardado.") });
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : t("Could not save alias.", "No se pudo guardar el alias."),
      });
    } finally {
      setSaving(false);
    }
  }, [value, t]);

  const handleDisconnect = useCallback(async () => {
    const confirmed = window.confirm(
      t(
        "Remove alias? This action cannot be undone.",
        "¿Eliminar alias? Esta acción no se puede deshacer.",
      ),
    );
    if (!confirmed) return;

    setDisconnecting(true);
    setNotice(null);
    try {
      await executeDashboardAction("business.update", { alias: null });
      setNotice({ kind: "ok", text: t("Alias removed.", "Alias eliminado.") });
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : t("Could not remove alias.", "No se pudo eliminar el alias."),
      });
    } finally {
      setDisconnecting(false);
    }
  }, [t]);

  const busy = saving || disconnecting;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {alreadyConnected && (
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          padding: "0.25rem 0.75rem",
          borderRadius: "999px",
          fontSize: "0.875rem",
          fontWeight: 600,
          backgroundColor: "var(--success-soft)",
          color: "var(--success)",
          alignSelf: "flex-start",
        }}>
          <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8" fill="none">
            <circle cx="4" cy="4" r="3.5" fill="currentColor" />
          </svg>
          {t(`Connected: ${currentAlias}`, `Conectado: ${currentAlias}`)}
        </div>
      )}
      <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0, lineHeight: 1.5 }}>
        {t(
          "Your Mercado Pago or CVU alias (e.g. carlos.mp). Customers use it to send you transfers.",
          "Tu alias de Mercado Pago o CVU (ej. carlos.mp). Lo usás para recibir transferencias.",
        )}
      </p>
      <label style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
        <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--tone-strong)" }}>
          {alreadyConnected ? t("Update alias", "Actualizar alias") : t("Alias", "Alias")}
        </span>
        <Input
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); }}
          placeholder={t("e.g. carlos.mp", "ej. carlos.mp")}
          disabled={busy}
        />
      </label>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <Button
          type="button"
          onClick={() => { void handleSave(); }}
          disabled={busy}
        >
          {saving ? t("Saving…", "Guardando…") : t("Save", "Guardar")}
        </Button>
        {alreadyConnected && (
          <Button
            type="button"
            variant="destructive"
            onClick={() => { void handleDisconnect(); }}
            disabled={busy}
          >
            {disconnecting ? t("Removing…", "Eliminando…") : t("Disconnect", "Desconectar")}
          </Button>
        )}
      </div>
      {notice && (
        <p
          role={notice.kind === "err" ? "alert" : undefined}
          style={{
            fontSize: "0.875rem",
            margin: 0,
            color: notice.kind === "ok" ? "var(--success, #065f46)" : "var(--danger)",
          }}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}

// ─── Card picker ──────────────────────────────────────────────────────────────

function ModalContent({ provider }: { provider: ProviderStatus }) {
  switch (provider.id) {
    case "mercadopago":       return <SettingsMercadoPagoCard />;
    case "modo":              return <SettingsModoCard />;
    case "arca":              return <SettingsFiscalCertCard />;
    case "andreani":
    case "oca":
    case "correo":            return <SettingsCourierCard restrictTo={provider.id as "andreani" | "oca" | "correo"} />;
    case "twilio_sms":
    case "resend":
    case "pedidosya":         return <SettingsComunicacionesCard restrictTo={provider.id as "twilio_sms" | "resend" | "pedidosya"} />;
    case "alias":             return <AliasForm currentAlias={provider.value} />;
    // Step 1.5c: WhatsApp Business — lighter phone-only capture (WABA deferred).
    case "whatsapp_business": return <WhatsAppBusinessForm currentPhone={provider.value} />;
    default:                  return (
      <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0 }}>
        Servicio no reconocido.
      </p>
    );
  }
}

// ─── Modal shell ──────────────────────────────────────────────────────────────

interface ConnectServiceModalProps {
  provider: ProviderStatus | null;
  onClose: () => void;
}

export function ConnectServiceModal({ provider, onClose }: ConnectServiceModalProps) {
  const t = useT();
  const title = provider ? t(`Connect ${provider.label}`, `Conectar ${provider.label}`) : "";

  return (
    <Dialog
      open={provider !== null}
      onOpenChange={(open) => { if (!open) onClose(); }}
    >
      <DialogContent
        className="max-w-[480px] max-h-[calc(100dvh-2rem)] overflow-hidden flex flex-col p-0"
        style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
      >
        <DialogHeader className="px-4 pt-4">
          <DialogTitle
            style={{
              fontFamily: "var(--font-dm-sans)",
              fontSize: "1.125rem",
              fontWeight: 700,
              color: "var(--tone-strong)",
              lineHeight: 1.3,
            }}
          >
            {title}
          </DialogTitle>
        </DialogHeader>
        <div style={{ overflowY: "auto", padding: "16px", flex: 1 }}>
          {provider && <ModalContent provider={provider} />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
