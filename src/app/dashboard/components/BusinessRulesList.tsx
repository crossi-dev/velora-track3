"use client";

import {
  isEnforceableKind,
  isReminderKind,
  type RuleRow,
} from "./BusinessRulesTab.shared";
import { RuleCard } from "./BusinessRulesCard";

interface RulesListProps {
  rules: RuleRow[];
  loading: boolean;
  onChange: () => void;
  t: (en: string, es: string) => string;
}

export function RulesList({ rules, loading, onChange, t }: RulesListProps) {
  if (loading && rules.length === 0) {
    return (
      <div style={{ padding: "2rem", textAlign: "center", color: "var(--tone-muted)", fontFamily: "var(--font-dm-sans)" }}>
        {t("Loading rules…", "Cargando reglas…")}
      </div>
    );
  }
  if (rules.length === 0) {
    return (
      <div
        style={{
          padding: "2rem 1.5rem",
          textAlign: "center",
          background: "var(--surface)",
          borderRadius: "12px",
          border: "1px dashed var(--border)",
          fontFamily: "var(--font-dm-sans)",
          color: "var(--tone-muted)",
        }}
      >
        {t(
          "No rules yet. Create one above or ask the chat: \"remind me every 2 hours to wash hands\".",
          "Todavía no hay reglas. Creá una arriba o pedíselo al chat: \"recordá que cada 2 horas hay que lavarse las manos\"."
        )}
      </div>
    );
  }
  const enforced = rules.filter((r) => isEnforceableKind(r.kind));
  const reminders = rules.filter((r) => isReminderKind(r.kind));
  const other = rules.filter((r) => !isEnforceableKind(r.kind) && !isReminderKind(r.kind));
  return (
    <div className="flex flex-col" style={{ gap: "1.5rem" }}>
      <RulesSection
        title={t("Rules (enforced)", "Reglas")}
        subtitle={t(
          "These rules are checked by the system. A violation blocks the operation.",
          "Estas reglas las verifica el sistema. Una violación bloquea la operación.",
        )}
        rules={enforced}
        onChange={onChange}
        t={t}
        emptyText={t("No enforced rules yet.", "Todavía no hay reglas verificadas.")}
      />
      <RulesSection
        title={t("Reminders", "Recordatorios")}
        subtitle={t(
          "Reminders for the team. The system mentions them in the chat but does not block the operation.",
          "Recordatorios para el equipo. El sistema los menciona en el chat pero no bloquea la operación.",
        )}
        rules={reminders}
        onChange={onChange}
        t={t}
        emptyText={t("No reminders yet.", "Todavía no hay recordatorios.")}
      />
      {other.length > 0 && (
        <RulesSection
          title={t("Other", "Otras")}
          subtitle=""
          rules={other}
          onChange={onChange}
          t={t}
          emptyText=""
        />
      )}
    </div>
  );
}

interface RulesSectionProps {
  title: string;
  subtitle: string;
  rules: RuleRow[];
  onChange: () => void;
  t: (en: string, es: string) => string;
  emptyText: string;
}

function RulesSection({ title, subtitle, rules, onChange, t, emptyText }: RulesSectionProps) {
  return (
    <section className="flex flex-col gap-2">
      <header className="flex flex-col" style={{ gap: "2px" }}>
        <h2
          style={{ margin: 0, fontSize: "1.25rem", fontFamily: "var(--font-dm-sans)", fontWeight: 600, lineHeight: 1.3, color: "var(--tone-strong)" }}
        >
          {title}
        </h2>
        {subtitle && (
          <p
            style={{
              margin: 0,
              color: "var(--tone-muted)",
              fontFamily: "var(--font-dm-sans)",
              fontSize: "0.875rem",
              lineHeight: 1.5,
            }}
          >
            {subtitle}
          </p>
        )}
      </header>
      {rules.length === 0 ? (
        <div
          style={{
            padding: "1rem 1.25rem",
            background: "var(--surface)",
            borderRadius: "12px",
            border: "1px dashed var(--border)",
            fontFamily: "var(--font-dm-sans)",
            color: "var(--tone-muted)",
            fontSize: "0.875rem",
          }}
        >
          {emptyText}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {rules.map((rule) => (
            <RuleCard key={rule.id} rule={rule} onChange={onChange} t={t} />
          ))}
        </div>
      )}
    </section>
  );
}
