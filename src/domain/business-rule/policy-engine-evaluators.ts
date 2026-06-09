// Evaluadores canónicos del motor de políticas.
// Cada evaluador es puro: recibe ctx + inputs, devuelve PolicyDecision | null.
// Para agregar un nuevo tipo de regla, agregar un nuevo evaluador acá y
// registrarlo en EVALUATORS.
//
// Los evaluadores NO leen DB. Reciben rules + policies pre-cargadas por
// el adapter en src/app/api/_lib/policy-evaluator.ts.

import type {
  DelegationPolicySnapshot,
  PolicyContext,
  PolicyDecision,
  PolicyEvaluator,
  PolicyInputs,
} from "./policy-engine-types";

/** Helper: encuentra primera policy activa con scope dado. */
function findPolicy(
  policies: ReadonlyArray<DelegationPolicySnapshot>,
  scope: string,
): DelegationPolicySnapshot | null {
  return policies.find((p) => p.active && p.scope === scope) ?? null;
}

/** Helper: extrae número desde unknown sin throw. */
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return null;
}

/** Helper: extrae string sin throw. */
function asString(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/** Helper: action.data como objeto. */
function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

// ─── 1. no_sale_without_customer (condition-based BusinessRule) ──────────────

export const noSaleWithoutCustomerEvaluator: PolicyEvaluator = {
  name: "no_sale_without_customer",
  appliesTo: (t) => t === "sale.create",
  evaluate(ctx, inputs) {
    const rule = inputs.rules.find(
      (r) => r.active && r.kind === "condition-based" && r.trigger === "no_sale_without_customer",
    );
    if (!rule) return null;
    const data = asObject(ctx.action.data);
    const customerId = data ? asString(data.customerId) : null;
    if (customerId) return null;
    return {
      allowed: false,
      ruleId: rule.id,
      code: "NO_SALE_WITHOUT_CUSTOMER",
      reason: rule.message || "Toda venta debe tener un cliente asociado.",
    };
  },
};

// ─── 2. max_return_amount (DelegationPolicy scope="return") ──────────────────

export const maxReturnAmountEvaluator: PolicyEvaluator = {
  name: "max_return_amount",
  appliesTo: (t) => t === "return-sale",
  evaluate(ctx, inputs) {
    if (ctx.actorRole !== "employee") return null;
    const policy = findPolicy(inputs.policies, "return");
    if (!policy) return null;
    if (policy.requiresOwner) {
      return {
        allowed: false,
        ruleId: policy.id,
        code: "MAX_RETURN_AMOUNT_EXCEEDED",
        reason: "Las devoluciones requieren aprobación del dueño.",
      };
    }
    if (policy.maxValue === null) return null;
    const data = asObject(ctx.action.data);
    const amount = data ? asNumber(data.amount) : null;
    if (amount === null) return null;
    if (amount <= policy.maxValue) return null;
    return {
      allowed: false,
      ruleId: policy.id,
      code: "MAX_RETURN_AMOUNT_EXCEEDED",
      reason: `Monto de devolución $${amount} excede el máximo permitido sin aprobación del dueño ($${policy.maxValue}).`,
    };
  },
};

// ─── 5. bulk_price_update — sólo dueño ───────────────────────────────────────
// El endpoint ya gatea por requireRole("owner"), pero el motor agrega defensa
// en profundidad y log estructurado.

export const bulkPriceUpdateEvaluator: PolicyEvaluator = {
  name: "bulk_price_update_owner_only",
  appliesTo: (t) => t === "bulk-price-update",
  evaluate(ctx, _inputs) {
    if (ctx.actorRole === "owner") return null;
    return {
      allowed: false,
      ruleId: "system:bulk-price-update",
      code: "BULK_PRICE_UPDATE_REQUIRES_OWNER",
      reason: "La actualización masiva de precios requiere autorización del dueño.",
    };
  },
};

// ─── 6. stock-load requires owner / monto máximo ─────────────────────────────

export const stockLoadEvaluator: PolicyEvaluator = {
  name: "stock_load_perimeter",
  appliesTo: (t) => t === "stock-load",
  evaluate(ctx, inputs) {
    if (ctx.actorRole === "owner") return null;
    const policy = findPolicy(inputs.policies, "stock");
    // No active policy → no restriction configured; allow the employee.
    if (!policy) return null;
    if (policy.requiresOwner) {
      return {
        allowed: false,
        ruleId: policy.id,
        code: "STOCK_LOAD_REQUIRES_OWNER",
        reason: "La carga de stock requiere aprobación del dueño.",
      };
    }
    if (policy.maxValue === null) return null;
    const data = asObject(ctx.action.data);
    const amount = data ? (asNumber(data.totalCost) ?? asNumber(data.amount)) : null;
    if (amount === null) return null;
    if (amount <= policy.maxValue) return null;
    return {
      allowed: false,
      ruleId: policy.id,
      code: "STOCK_LOAD_REQUIRES_OWNER",
      reason: `Ingreso por $${amount} excede el límite ($${policy.maxValue}).`,
    };
  },
};

export const EVALUATORS: ReadonlyArray<PolicyEvaluator> = [
  noSaleWithoutCustomerEvaluator,
  maxReturnAmountEvaluator,
  bulkPriceUpdateEvaluator,
  stockLoadEvaluator,
];

/** Itera evaluadores aplicables, corta en la primera deny. */
export function runEvaluators(
  ctx: PolicyContext,
  inputs: PolicyInputs,
): PolicyDecision {
  for (const ev of EVALUATORS) {
    if (!ev.appliesTo(ctx.action.type)) continue;
    const decision = ev.evaluate(ctx, inputs);
    if (decision && decision.allowed === false) return decision;
  }
  return { allowed: true };
}
