// Motor de políticas de Velora — capa de dominio.
//
// API pública:
//   - evaluatePolicy(ctx, inputs) → PolicyDecision
//   - filterEnforceableRules(rules) → solo "condition-based"
//   - isBehaviorRule(rule) / isReminderRule(rule)
//
// Diseño:
//   - El engine es PURO: no lee DB, no llama APIs, no logea. Recibe
//     `rules` y `policies` ya cargadas y devuelve un veredicto.
//   - El adapter en src/app/api/_lib/policy-evaluator.ts hace I/O:
//     carga rules + policies de Prisma, invoca evaluatePolicy(), y
//     emite cloudLog del resultado.
//   - Behavior rules (kind="behavior-based") y time-based rules son
//     RECORDATORIOS y no se evalúan acá. Quedan como advisory en el
//     prompt del supervisor/companion.
//
// Para agregar una regla nueva: ir a policy-engine-evaluators.ts.

import type {
  PolicyContext,
  PolicyDecision,
  PolicyInputs,
} from "./policy-engine-types";
import { runEvaluators } from "./policy-engine-evaluators";

export type {
  PolicyContext,
  PolicyDecision,
  PolicyInputs,
  PolicyDenialCode,
  PolicyActionType,
  ActorRole,
  PolicyEvaluator,
  DelegationPolicySnapshot,
  BusinessRuleSnapshot,
} from "./policy-engine-types";

export { EVALUATORS } from "./policy-engine-evaluators";

/**
 * Evalúa el contexto contra rules y policies pre-cargadas.
 * El primer evaluador que devuelve `allowed:false` corta la cadena.
 * Si ningún evaluador deny, allowed:true.
 */
export function evaluatePolicy(
  ctx: PolicyContext,
  inputs: PolicyInputs,
): PolicyDecision {
  return runEvaluators(ctx, inputs);
}

/** Devuelve true si la regla se verifica en el server (gate real). */
export function isEnforceableRule(rule: { kind: string }): boolean {
  return rule.kind === "condition-based";
}

/** Devuelve true si la regla es advisory (recordatorio para el equipo). */
export function isReminderRule(rule: { kind: string }): boolean {
  return rule.kind === "behavior-based" || rule.kind === "time-based";
}

/** Filtra solo las reglas verificables del lote. */
export function filterEnforceableRules<R extends { kind: string }>(
  rules: ReadonlyArray<R>,
): R[] {
  return rules.filter(isEnforceableRule);
}

/** Filtra solo las recordatorios del lote. */
export function filterReminderRules<R extends { kind: string }>(
  rules: ReadonlyArray<R>,
): R[] {
  return rules.filter(isReminderRule);
}
