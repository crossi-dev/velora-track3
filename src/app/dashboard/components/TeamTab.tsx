"use client";

// TanStack Query cache: team + business-rules data is cached via useQuery so
// revisiting this tab within the staleTime window (30s default) is instant.
// Source: https://tanstack.com/query/latest/docs/framework/react/overview

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, UsersThree } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { TeamSuccessBanner } from "./TeamSuccessBanner";
import type { BusinessSummary } from "../lib/types";
import { SectionMarker } from "./v2/SectionMarker";
import { TeamCreateEmployeeSheet } from "./TeamCreateEmployeeSheet";
import { TeamEmployeeRow } from "./TeamEmployeeRow";
import { useTeamData, type EmployeeRecord, type ActivityRow } from "../lib/hooks/useTeamData";
import { ErrorBanner } from "./ErrorBanner";
import { type RuleRow } from "./BusinessRulesTab.shared";
import { RulesList } from "./BusinessRulesList";

interface TeamTabProps {
  business: BusinessSummary;
  moneyFmt: (amount: number, currency: string) => string;
  t: (en: string, es: string) => string;
}

const RULES_QUERY_KEY = ["business-rules"] as const;

async function fetchBusinessRules(): Promise<{ rules: RuleRow[] }> {
  const res = await fetch("/api/business/business-rules", { cache: "no-store" });
  if (!res.ok) {
    const friendly = res.status >= 500
      ? "El servidor no está respondiendo. Intentá de nuevo en unos momentos."
      : "No se pudo conectar con el servidor.";
    throw new Error(friendly);
  }
  return (await res.json()) as { rules: RuleRow[] };
}

function useBusinessRules() {
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: RULES_QUERY_KEY,
    queryFn: fetchBusinessRules,
  });

  const reload = () => {
    void queryClient.invalidateQueries({ queryKey: RULES_QUERY_KEY });
  };

  return {
    rules: data?.rules ?? [],
    loading: isLoading,
    loadError: error instanceof Error ? error.message : null,
    reload,
  };
}

export function TeamTab({ business, moneyFmt, t }: TeamTabProps) {
  const {
    employees,
    activityById,
    loading,
    loadError,
    createState,
    resetCreateState,
    handleCreate,
    handleRevoke,
    handleUnlock,
  } = useTeamData(t);
  const { rules, loading: rulesLoading, loadError: rulesError, reload: reloadRules } = useBusinessRules();
  const [sheetOpen, setSheetOpen] = useState(false);

  const loginUrl = useMemo(() => {
    if (typeof window === "undefined") return null;
    return `${window.location.origin}/employee-login?b=${encodeURIComponent(business.id)}`;
  }, [business.id]);

  const activeCount = employees.filter((e) => e.active).length;

  return (
    <div className="flex flex-col gap-4" style={{ maxWidth: "720px", margin: "0 auto", width: "100%", paddingBottom: "var(--gutter)" }}>
      <TeamHeader t={t} />

      <div className="flex items-center justify-between" style={{ marginTop: "0.5rem" }}>
        <div style={{ fontSize: "0.875rem", color: "var(--tone-muted)" }}>
          {t(
            `Today's activity — ${activeCount} ${activeCount === 1 ? "active employee" : "active employees"}`,
            `Actividad de hoy — ${activeCount} ${activeCount === 1 ? "empleado activo" : "empleados activos"}`,
          )}
        </div>
        {employees.length > 0 && (
          <Button
            type="button"
            onClick={() => { resetCreateState(); setSheetOpen(true); }}
            className="gap-1.5"
          >
            <PlusIcon weight="bold" aria-hidden />
            {t("Add employee", "Agregar empleado")}
          </Button>
        )}
      </div>

      {loadError && <ErrorBanner message={loadError} />}
      {createState.notice && <TeamSuccessBanner notice={createState.notice} pin={createState.pin} loginUrl={loginUrl} onDismiss={resetCreateState} t={t} />}

      <TeamBody
        loading={loading}
        employees={employees}
        activityById={activityById}
        currency={business.currency}
        moneyFmt={moneyFmt}
        onAdd={() => setSheetOpen(true)}
        onRevoke={handleRevoke}
        onUnlock={handleUnlock}
        t={t}
      />

      <hr style={{ border: "none", borderTop: "1px solid var(--border)", margin: "0.5rem 0" }} />

      <BusinessRulesSection rules={rules} loading={rulesLoading} loadError={rulesError} onReload={reloadRules} t={t} />

      <TeamCreateEmployeeSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        onSubmit={async (input) => {
          const ok = await handleCreate(input);
          if (ok) setSheetOpen(false);
        }}
        saving={createState.saving}
        error={createState.error}
        t={t}
      />
    </div>
  );
}

function TeamHeader({ t }: { t: (en: string, es: string) => string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <SectionMarker label={t("Team", "Equipo")} number="06" />
      <h1
        className="t-display-3"
        style={{ color: "var(--tone-strong)", margin: 0 }}
      >
        {t("Team", "Equipo")}
      </h1>
      <p style={{ margin: 0, color: "var(--tone-muted)", fontSize: "0.9375rem" }}>
        {t(
          "Each employee operates with their PIN. Velora teaches them to use the business without you having to explain anything.",
          "Cada empleado opera con su PIN. Velora les enseña a usar el negocio sin que tengas que explicar nada.",
        )}
      </p>
    </div>
  );
}

interface BusinessRulesSectionProps {
  rules: RuleRow[];
  loading: boolean;
  loadError: string | null;
  onReload: () => void;
  t: (en: string, es: string) => string;
}

function BusinessRulesSection({ rules, loading, loadError, onReload, t }: BusinessRulesSectionProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 style={{ margin: 0, fontSize: "1.25rem", fontWeight: 600, color: "var(--tone-strong)", fontFamily: "var(--font-dm-sans)", lineHeight: 1.3 }}>
          {t("Business rules", "Reglas del negocio")}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onReload}
          disabled={loading}
          className="text-[var(--tone-muted)]"
        >
          {t("Refresh", "Refrescar")}
        </Button>
      </div>
      {loadError && <ErrorBanner message={loadError} />}
      <RulesList rules={rules} loading={loading} onChange={onReload} t={t} />
    </div>
  );
}

interface TeamBodyProps {
  loading: boolean;
  employees: EmployeeRecord[];
  activityById: Map<string, ActivityRow>;
  currency: string;
  moneyFmt: (amount: number, currency: string) => string;
  onAdd: () => void;
  onRevoke: (employeeId: string, name: string) => void;
  onUnlock: (employeeId: string) => void;
  t: (en: string, es: string) => string;
}

function TeamBody({ loading, employees, activityById, currency, moneyFmt, onAdd, onRevoke, onUnlock, t }: TeamBodyProps) {
  if (loading) {
    return (
      <div
        style={{
          padding: "2rem",
          textAlign: "center",
          color: "var(--tone-muted)",
        }}
      >
        {t("Loading team…", "Cargando equipo…")}
      </div>
    );
  }
  if (employees.length === 0) {
    return <EmptyState t={t} onAdd={onAdd} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {employees.map((emp) => (
        <TeamEmployeeRow
          key={emp.id}
          employee={emp}
          activity={activityById.get(emp.id) ?? null}
          currency={currency}
          moneyFmt={moneyFmt}
          onRevoke={onRevoke}
          onUnlock={onUnlock}
          t={t}
        />
      ))}
    </div>
  );
}

function EmptyState({ t, onAdd }: { t: (en: string, es: string) => string; onAdd: () => void }) {
  return (
    <div
      style={{
        padding: "2.5rem 1.5rem",
        textAlign: "center",
        background: "var(--surface, white)",
        borderRadius: "16px",
        border: "1px dashed var(--border, #e5e5e5)",
      }}
    >
      <UsersThree size={32} weight="duotone" style={{ color: "var(--tone-muted)" }} />
      <h2
        className="font-fraunces"
        style={{
          margin: "1rem 0 0.5rem",
          fontSize: "1.25rem",
          fontWeight: 400,
          color: "var(--tone-strong)",
        }}
      >
        {t("No employees yet", "Todavía no tenés empleados")}
      </h2>
      <p style={{ margin: "0 0 1rem", color: "var(--tone-muted)", fontSize: "0.9375rem" }}>
        {t(
          "Add your first cashier. Velora welcomes them and teaches them to sell in chat.",
          "Agregá tu primer cajero. Velora lo recibe con un saludo y le enseña a vender en el chat.",
        )}
      </p>
      <Button
        type="button"
        onClick={onAdd}
        className="gap-1.5"
      >
        <PlusIcon weight="bold" aria-hidden />
        {t("Add employee", "Agregar empleado")}
      </Button>
    </div>
  );
}
