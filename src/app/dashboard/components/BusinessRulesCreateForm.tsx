"use client";

import { useState, useRef, useEffect } from "react";
import { Plus } from "@phosphor-icons/react";
import { ErrorBanner } from "./BusinessRulesTab.shared";
import { useT } from "../lib/DashboardLangContext";

interface CreateFormProps {
  onCreated: () => void;
  t?: (en: string, es: string) => string;
}

function toTriggerSlug(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_áéíóúñ]/g, "").slice(0, 120);
}

// Heuristic — infer kind from the message text.
// Time patterns ("a las 8", "cada 2 horas", "todos los lunes") → time-based.
// Anything else → behavior-based (advisory reminder).
// condition-based rules are created via chat / import, not via this form.
function inferKindFromMessage(message: string): "behavior-based" | "time-based" {
  const lower = message.toLowerCase();
  if (/\ba las \d{1,2}(:\d{2})?/.test(lower)) return "time-based";
  if (/\bcada \d+\s*(hora|hs|min|minuto)/.test(lower)) return "time-based";
  if (/\btodos los (lunes|martes|mi(é|e)rcoles|jueves|viernes|s(á|a)bados?|domingos?)/.test(lower)) return "time-based";
  return "behavior-based";
}

// Detect condition-based patterns that the form cannot handle correctly.
// These need to be created via chat so the server can wire them to the enforcement engine.
const CONDITION_STOCK_RE = /bajo|menos de|menor a|cuando.*tenga|si.*hay (menos|pocas?)|stock.*menor/i;
const CONDITION_CUSTOMER_RE = /sin cliente|cliente obligatorio|toda venta con cliente/i;

function looksLikeConditionBased(message: string): boolean {
  if (CONDITION_CUSTOMER_RE.test(message)) return true;
  // Stock patterns require a number to avoid false positives on generic phrases
  return CONDITION_STOCK_RE.test(message) && /\d/.test(message);
}

export function CreateForm({ onCreated, t: tProp }: CreateFormProps) {
  const tHook = useT();
  const t = tProp ?? tHook;
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const isConditionBased = looksLikeConditionBased(message);

  useEffect(() => {
    if (typeof window !== "undefined" && !window.matchMedia("(pointer: coarse)").matches) {
      inputRef.current?.focus();
    }
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!message.trim()) { setFormError(t("Write the rule.", "Escribí la regla.")); return; }
    if (isConditionBased) return; // blocked — warning already shown
    setFormError(null);
    setSaving(true);
    try {
      const kind = inferKindFromMessage(message);
      const res = await fetch("/api/business/business-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          trigger: toTriggerSlug(message),
          message: message.trim(),
        }),
      });
      if (res.status === 409) { setFormError(t("A duplicate rule already exists.", "Ya existe una regla igual.")); return; }
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        setFormError(errBody.error ?? `Error ${res.status}`); return;
      }
      setMessage("");
      onCreated();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} style={FORM_STYLE}>
      <div style={FORM_HEADER_STYLE}>
        <span style={FORM_TITLE_STYLE}>{t("Create new rule", "Crear regla nueva")}</span>
      </div>
      <div style={FIELDS_STYLE}>
        <input
          type="text"
          ref={inputRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t("E.g.: Take out the trash at 8 PM", "Ej: Sacar la basura a las 20 hs")}
          style={INPUT_STYLE}
        />
        {isConditionBased && (
          <div style={CONDITION_WARNING_STYLE}>
            {t(
              "This rule looks like a condition (e.g. stock alert). To enforce it correctly, create it via chat — the form only supports reminders and time-based rules.",
              "Esta regla parece ser de tipo 'condición' (ej: alerta de stock). Para que se active correctamente, creala por el chat — el formulario solo acepta recordatorios y reglas de horario.",
            )}
          </div>
        )}
        {formError && <ErrorBanner message={formError} />}
      </div>
      <button type="submit" disabled={saving || isConditionBased} style={{ ...SUBMIT_STYLE, ...(isConditionBased ? SUBMIT_DISABLED_STYLE : {}) }}>
        <Plus size={16} weight="bold" />
        {saving ? t("Saving…", "Guardando…") : t("Create rule", "Crear regla")}
      </button>
    </form>
  );
}

const FORM_STYLE: React.CSSProperties = {
  background: "var(--surface-raised, var(--surface))",
  border: "1px solid var(--border)",
  borderRadius: "16px",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  gap: 0,
};
const FORM_HEADER_STYLE: React.CSSProperties = {
  padding: "14px 20px",
  borderBottom: "1px solid var(--border)",
  background: "var(--surface)",
};
const FORM_TITLE_STYLE: React.CSSProperties = {
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.9375rem",
  fontWeight: 600,
  color: "var(--tone-strong)",
  letterSpacing: "-0.01em",
};
const FIELDS_STYLE: React.CSSProperties = {
  padding: "20px",
  display: "flex",
  flexDirection: "column",
  gap: "14px",
};
const INPUT_STYLE: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "1px solid var(--border)",
  borderRadius: "10px",
  fontFamily: "var(--font-dm-sans)",
  fontSize: "1rem",
  background: "var(--surface)",
  color: "var(--tone-strong)",
  lineHeight: 1.5,
};
const SUBMIT_STYLE: React.CSSProperties = {
  alignSelf: "flex-end",
  margin: "0 20px 20px",
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: "10px 18px",
  minHeight: "44px",
  background: "var(--tone-strong)",
  color: "var(--surface)",
  border: "none",
  borderRadius: "10px",
  cursor: "pointer",
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.9375rem",
  fontWeight: 500,
};
const SUBMIT_DISABLED_STYLE: React.CSSProperties = {
  opacity: 0.4,
  cursor: "not-allowed",
};
const CONDITION_WARNING_STYLE: React.CSSProperties = {
  padding: "10px 14px",
  background: "color-mix(in srgb, #f59e0b 12%, transparent)",
  border: "1px solid color-mix(in srgb, #f59e0b 40%, transparent)",
  borderRadius: "8px",
  fontFamily: "var(--font-dm-sans)",
  fontSize: "0.875rem",
  color: "var(--tone-strong)",
  lineHeight: 1.5,
};
