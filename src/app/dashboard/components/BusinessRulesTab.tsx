"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { SectionMarker } from "./v2/SectionMarker";
import { ErrorBanner, type RuleRow } from "./BusinessRulesTab.shared";
import { CreateForm } from "./BusinessRulesCreateForm";
import { RulesList } from "./BusinessRulesList";
import { BusinessRulesImportButton } from "./BusinessRulesImportButton";

interface BusinessRulesTabProps {
  t: (en: string, es: string) => string;
}

export function BusinessRulesTab({ t }: BusinessRulesTabProps) {
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/business/business-rules", { cache: "no-store" });
      if (!res.ok) {
        const friendly =
          res.status === 429
            ? "Demasiadas solicitudes. Esperá unos segundos y volvé a intentarlo."
            : res.status >= 500
              ? "El servidor no está respondiendo. Intentá de nuevo en unos momentos."
              : "No se pudo conectar con el servidor.";
        throw new Error(friendly);
      }
      const data = (await res.json()) as { rules: RuleRow[] };
      setRules(data.rules);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div
      className="flex flex-col gap-4"
      style={{ maxWidth: "960px", margin: "0 auto", width: "100%", paddingBottom: "var(--gutter)" }}
    >
      <Header t={t} count={rules.length} loading={loading} onRefresh={reload} onImported={reload} />
      {loadError && <ErrorBanner message={`No se pudieron cargar las reglas: ${loadError}`} />}
      <CreateForm onCreated={reload} t={t} />
      <RulesList rules={rules} loading={loading} onChange={reload} t={t} />
    </div>
  );
}

interface HeaderProps {
  t: (en: string, es: string) => string;
  count: number;
  loading: boolean;
  onRefresh: () => void;
  onImported: () => void;
}

function Header({ t, count, loading, onRefresh, onImported }: HeaderProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between" style={{ gap: "8px", flexWrap: "wrap" }}>
        <SectionMarker label={t("Rules", "Reglas")} number="10" />
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <BusinessRulesImportButton onImported={onImported} />
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              padding: "6px 10px",
              background: "transparent",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              color: "var(--tone-muted)",
              cursor: loading ? "wait" : "pointer",
              fontFamily: "var(--font-dm-sans)",
              fontSize: "0.875rem",
            }}
          >
            <ArrowsClockwise size={14} weight="bold" />
            {t("Refresh", "Refrescar")}
          </button>
        </div>
      </div>
      <h1 className="t-display-3" style={{ margin: 0, color: "var(--tone-strong)" }}>
        {t("Business rules", "Reglas del negocio")}
      </h1>
      <p
        style={{
          margin: 0,
          color: "var(--tone-muted)",
          fontFamily: "var(--font-dm-sans)",
          fontSize: "1rem",
        }}
      >
        {count > 0
          ? t(
              `${count} active rule${count === 1 ? "" : "s"}. Velora communicates them automatically to your team. You can also create them by chatting or importing a document.`,
              `${count} regla${count === 1 ? "" : "s"} activa${count === 1 ? "" : "s"}. Velora las comunica automáticamente a tu equipo. También podés crearlas hablando en el chat o importando un documento.`,
            )
          : t(
              "Create rules for your team by chatting with Velora, filling in the form below, or importing a PDF or Word document with your guidelines.",
              "Creá reglas para tu equipo hablando con Velora en el chat, llenando el formulario abajo, o importando un PDF o Word con tus normas.",
            )}
      </p>
    </div>
  );
}
