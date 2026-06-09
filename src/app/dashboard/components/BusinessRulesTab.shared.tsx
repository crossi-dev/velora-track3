"use client";

// Tipos + constantes + componentes pequeños compartidos por
// BusinessRulesTab y sus splits (CreateForm, RulesList).

export interface RuleRow {
  id: string;
  kind: string;
  trigger: string;
  message: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Reglas verificadas por el motor en src/domain/business-rule/policy-engine.ts. */
export function isEnforceableKind(kind: string): boolean {
  return kind === "condition-based";
}

/** Recordatorios advisory: el supervisor los menciona pero no bloquean. */
export function isReminderKind(kind: string): boolean {
  return kind === "behavior-based" || kind === "time-based";
}

/** Etiqueta legible por kind para mostrar en UI. */
export function kindLabel(kind: string, t: (en: string, es: string) => string): string {
  if (kind === "condition-based") return t("Rule (checks and blocks)", "Regla (verifica y bloquea)");
  if (kind === "behavior-based") return t("Reminder (suggests)", "Recordatorio (sugiere)");
  if (kind === "time-based") return t("Scheduled reminder", "Recordatorio programado");
  return kind;
}

export { ErrorBanner } from "./ErrorBanner";
