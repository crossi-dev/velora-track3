// Tipos del motor de políticas.
// Mantiene el dominio puro: sin Prisma, sin Next, sin frameworks.
//
// `BusinessRule` y `DelegationPolicy` viven en src/domain/business-rule.ts
// y prisma/schema.prisma respectivamente. Este modulo replica solo los
// campos que el motor necesita para evaluar — desacoplado del ORM.

import type { BusinessRuleKind } from "../business-rule";

/** Snapshot mínimo de una regla, suficiente para que el engine la evalúe.
 *  `kind` es string (no enum estricto) para tolerar valores DB legacy. */
export interface BusinessRuleSnapshot {
  id: string;
  kind: string;
  trigger: string;
  message: string;
  active: boolean;
}

export type ActorRole = "owner" | "employee";

export type PolicyDenialCode =
  | "NO_SALE_WITHOUT_CUSTOMER"
  | "MAX_RETURN_AMOUNT_EXCEEDED"
  | "BULK_PRICE_UPDATE_REQUIRES_OWNER"
  | "STOCK_LOAD_REQUIRES_OWNER";

export type PolicyActionType =
  | "sale.create"
  | "return-sale"
  | "stock-load"
  | "bulk-price-update";

export interface PolicyContext {
  businessId: string;
  actorId: string;
  actorRole: ActorRole;
  action: { type: PolicyActionType; data: unknown };
}

export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; ruleId: string; code: PolicyDenialCode };

export interface DelegationPolicySnapshot {
  id: string;
  scope: string;
  maxValue: number | null;
  requiresOwner: boolean;
  conditions: string;
  active: boolean;
}

export interface PolicyInputs {
  rules: ReadonlyArray<BusinessRuleSnapshot>;
  policies: ReadonlyArray<DelegationPolicySnapshot>;
}

export interface PolicyEvaluator {
  /** identificador estable para audit logs y debugging. */
  readonly name: string;
  /** filtra para qué action.type aplica este evaluador. */
  appliesTo(actionType: PolicyActionType): boolean;
  /** retorna deny | allowed. La primera deny corta la cadena. */
  evaluate(ctx: PolicyContext, inputs: PolicyInputs): PolicyDecision | null;
}

export type { BusinessRuleKind };
