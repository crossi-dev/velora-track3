"use client";

// WhatsApp Business phone capture form — Step 1.5c.
//
// Lightweight pre-Embedded-Signup path: captures Business.whatsappBusinessPhoneE164
// only (E.164 format). Full WABA token + Meta Embedded Signup is deferred until
// Velora completes Meta Tech Provider enrollment.
//
// Source — Shopify dismiss pattern ("option to complete at a later time"):
//   https://shopify.dev/docs/apps/design/user-experience/onboarding
// Source — Meta Embedded Signup (deferred — Tech Provider enrollment required):
//   https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/
// Source — Stripe Incremental currently_due (capture only what's needed now):
//   https://docs.stripe.com/connect/custom/hosted-onboarding

import { useCallback, useState } from "react";
import { executeDashboardAction } from "../lib/actions/executeDashboardAction";
import { useT } from "../lib/DashboardLangContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface WhatsAppBusinessFormProps {
  currentPhone?: string;
}

export function WhatsAppBusinessForm({ currentPhone }: WhatsAppBusinessFormProps) {
  const t = useT();
  const alreadySet = !!(currentPhone && currentPhone.trim().length > 0);
  const [value, setValue] = useState(currentPhone ?? "");
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const handleSave = useCallback(async () => {
    const phone = value.trim();
    if (!phone) {
      setNotice({ kind: "err", text: t("Enter a phone number.", "Ingresá un número de teléfono.") });
      return;
    }
    // E.164 client-side pre-check before hitting the server.
    if (!/^\+\d{7,15}$/.test(phone)) {
      setNotice({
        kind: "err",
        text: t(
          "Use E.164 format: +54911XXXXXXXX (country code + number, no spaces).",
          "Usá formato E.164: +54911XXXXXXXX (código de país + número, sin espacios).",
        ),
      });
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      await executeDashboardAction("business.update", { whatsappBusinessPhoneE164: phone });
      setNotice({ kind: "ok", text: t("WhatsApp Business number saved.", "Número de WhatsApp Business guardado.") });
    } catch (err) {
      setNotice({
        kind: "err",
        text: err instanceof Error ? err.message : t("Could not save the number.", "No se pudo guardar el número."),
      });
    } finally {
      setSaving(false);
    }
  }, [value, t]);

  if (dismissed) {
    return (
      <p style={{ fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0 }}>
        {t(
          "You can connect WhatsApp Business later from this screen.",
          "Podés conectar WhatsApp Business más tarde desde esta pantalla.",
        )}
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
      {alreadySet && (
        <div style={{
          display: "inline-flex", alignItems: "center", gap: "6px",
          padding: "0.25rem 0.75rem", borderRadius: "999px",
          fontSize: "0.875rem", fontWeight: 600,
          backgroundColor: "var(--success-soft)", color: "var(--success)",
          alignSelf: "flex-start",
        }}>
          <svg aria-hidden="true" width="8" height="8" viewBox="0 0 8 8" fill="none">
            <circle cx="4" cy="4" r="3.5" fill="currentColor" />
          </svg>
          {t(`Connected: ${currentPhone}`, `Conectado: ${currentPhone}`)}
        </div>
      )}

      {/* Placeholder notice — Meta Embedded Signup deferred until Tech Provider enrollment */}
      <p style={{
        fontSize: "0.875rem", color: "var(--tone-muted)", margin: 0, lineHeight: 1.5,
        padding: "10px 12px", background: "var(--brand-soft)",
        borderRadius: "var(--radius-sm)", borderLeft: "3px solid var(--brand)",
      }}>
        {t(
          "Full WhatsApp Business API connection (Embedded Signup) is coming soon. For now, enter your WhatsApp Business number manually to receive orders and send receipts.",
          "La conexión completa con la API de WhatsApp Business (Embedded Signup) está próximamente. Por ahora, ingresá tu número de WhatsApp Business manualmente para recibir pedidos y enviar comprobantes.",
        )}
      </p>

      <label style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
        <span style={{ fontSize: "0.875rem", fontWeight: 600, color: "var(--tone-strong)" }}>
          {t("WhatsApp Business number (E.164)", "Número de WhatsApp Business (E.164)")}
        </span>
        <Input
          type="tel"
          value={value}
          onChange={(e) => { setValue(e.target.value); }}
          placeholder={t("+54911XXXXXXXX", "+54911XXXXXXXX")}
          disabled={saving}
        />
      </label>

      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <Button
          type="button"
          onClick={() => { void handleSave(); }}
          disabled={saving}
        >
          {saving ? t("Saving…", "Guardando…") : t("Save", "Guardar")}
        </Button>
        {/* Dismiss per Shopify pattern: "Give merchants the option to complete later" */}
        <Button
          type="button"
          variant="outline"
          onClick={() => { setDismissed(true); }}
          disabled={saving}
        >
          {t("Do it later", "Lo hago después")}
        </Button>
      </div>

      {notice && (
        <p
          role={notice.kind === "err" ? "alert" : undefined}
          style={{
            fontSize: "0.875rem", margin: 0,
            color: notice.kind === "ok" ? "var(--success, #065f46)" : "var(--danger)",
          }}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
