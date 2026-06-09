"use client";

import { useState } from "react";
import { Trash } from "@phosphor-icons/react";
import { ErrorBanner, kindLabel, type RuleRow } from "./BusinessRulesTab.shared";
import { Toggle } from "./SettingsShared";

export interface RuleCardProps {
  rule: RuleRow;
  onChange: () => void;
  t: (en: string, es: string) => string;
}

export function RuleCard({ rule, onChange, t }: RuleCardProps) {
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  const toggleActive = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/business/business-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ active: !rule.active }),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/business/business-rules/${rule.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setPendingDeleteId(null);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "12px",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        opacity: rule.active ? 1 : 0.55,
        transition: "opacity 0.15s",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span
          style={{
            fontFamily: "var(--font-dm-sans)",
            fontSize: "0.875rem",
            color: "var(--tone-muted)",
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            padding: "2px 6px",
          }}
        >
          {kindLabel(rule.kind, t)}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: "8px", alignItems: "center" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontFamily: "var(--font-dm-sans)",
              fontSize: "0.875rem",
              color: "var(--tone-muted)",
            }}
          >
            <Toggle
              checked={rule.active}
              onChange={() => void toggleActive()}
              disabled={busy}
            />
            {rule.active ? t("Active", "Activa") : t("Paused", "Pausada")}
          </span>
          {pendingDeleteId === rule.id ? (
            <>
              <button
                type="button"
                onClick={() => void remove()}
                disabled={busy}
                style={{
                  fontFamily: "var(--font-dm-sans)",
                  fontSize: "0.875rem",
                  fontWeight: 700,
                  color: "var(--danger, #dc2626)",
                  background: "transparent",
                  border: "1px solid var(--danger, #dc2626)",
                  borderRadius: "6px",
                  padding: "4px 10px",
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                {busy ? "…" : t("Yes, delete", "Sí, eliminar")}
              </button>
              <button
                type="button"
                onClick={() => setPendingDeleteId(null)}
                disabled={busy}
                style={{
                  fontFamily: "var(--font-dm-sans)",
                  fontSize: "0.875rem",
                  color: "var(--tone-muted)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  padding: "4px 10px",
                  cursor: busy ? "wait" : "pointer",
                }}
              >
                {t("Cancel", "Cancelar")}
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setPendingDeleteId(rule.id)}
              disabled={busy}
              aria-label={t("Delete", "Eliminar")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                padding: "6px",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: "6px",
                color: "var(--danger, #dc2626)",
                cursor: busy ? "wait" : "pointer",
              }}
            >
              <Trash size={14} weight="bold" />
            </button>
          )}
        </span>
      </div>

      <p
        style={{
          margin: 0,
          fontFamily: "var(--font-dm-sans)",
          fontSize: "0.9375rem",
          color: "var(--tone-strong)",
          lineHeight: 1.5,
        }}
      >
        {rule.message}
      </p>
      {error && <ErrorBanner message={error} />}
    </div>
  );
}
