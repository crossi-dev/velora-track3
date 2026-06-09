// Generates a plain-English summary of active domain rules for injection
// into the supervisor system prompt. No UI, no framework dependencies.
//
// Naming: "RULES (enforced)" = el sistema verifica y bloquea.
// Las "REMINDERS" (behavior-based, time-based) NO viven en este resumen
// estático — se inyectan dinámicamente en el contexto del supervisor con
// la lista de reglas activas del negocio.

export function buildDomainRulesSummary(): string {
  return [
    "BUSINESS RULES (enforced — system blocks the operation if violated):",
    "- Sale total must be > 0. Hard block for all.",
    "- Stock shortfall (requested > available): hard block for all.",
    "- Price outlier (±50% from catalog): hard block for employee, warning for owner.",
    "- Product name required. Hard block.",
    "- Product price must be > 0. Hard block.",
    "- Cash movement amount must be > 0. Hard block.",
    "- Cash movement description required. Hard block.",
    "- Sale must have at least one item. Hard block.",
    "- Sale item quantity must be a positive whole number. Hard block.",
    "- Invoice must be linked to a sale. Hard block.",
    "- Invoice number is required. Hard block.",
    "",
    "POLICY ENGINE (server-side enforcement of owner-configured rules):",
    "- Condition-based BusinessRule + DelegationPolicy are checked on each mutation.",
    "- A violation returns 403 POLICY_DENIED with code + reason + ruleId.",
    "- Behavior-based and time-based rules are REMINDERS — surfaced via chat, never block.",
  ].join("\n");
}
