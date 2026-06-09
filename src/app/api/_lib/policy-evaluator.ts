// Adapter del motor de políticas para rutas API.
// Carga rules + policies de Prisma, invoca evaluatePolicy() del dominio,
// emite cloudLog estructurado del veredicto, y devuelve el decision.
//
// Patrón de uso en una ruta:
//   const ctx = await resolveActor(req);
//   ...
//   const decision = await enforcePolicy({
//     businessId: ctx.businessId,
//     actorId: ctx.actorEmployeeId ?? ctx.actorUserId,
//     actorRole: ctx.role,
//     action: { type: "sale.create", data: { customerId, total } },
//   });
//   if (!decision.allowed) return policyDeniedResponse(decision);

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import {
  evaluatePolicy,
  type DelegationPolicySnapshot,
  type PolicyContext,
  type PolicyDecision,
} from "@/domain/business-rule/policy-engine";

interface RuleSnapshot {
  id: string;
  kind: string;
  trigger: string;
  message: string;
  active: boolean;
}

async function loadInputs(businessId: string): Promise<{
  rules: RuleSnapshot[];
  policies: DelegationPolicySnapshot[];
  reminderCount: number;
}> {
  const [rawRules, rawPolicies] = await Promise.all([
    prisma.businessRule.findMany({
      where: { businessId, active: true },
      select: { id: true, kind: true, trigger: true, message: true, active: true },
    }),
    prisma.delegationPolicy.findMany({
      where: { businessId, active: true },
      select: { id: true, scope: true, maxValue: true, requiresOwner: true, conditions: true, active: true },
    }),
  ]);

  const policies: DelegationPolicySnapshot[] = rawPolicies.map((p) => ({
    id: p.id,
    scope: p.scope,
    maxValue: p.maxValue === null ? null : Number(p.maxValue),
    requiresOwner: p.requiresOwner,
    conditions: p.conditions,
    active: p.active,
  }));

  const rules: RuleSnapshot[] = rawRules.map((r) => ({
    id: r.id,
    kind: r.kind,
    trigger: r.trigger,
    message: r.message,
    active: r.active,
  }));

  const reminderCount = rules.filter((r) => r.kind === "behavior-based" || r.kind === "time-based").length;
  return { rules, policies, reminderCount };
}

/**
 * Evalúa la acción contra rules+policies. Cada decisión queda audit-eada
 * en cloudLog con event POLICY_DECISION (allowed) o POLICY_DENIED (deny).
 * Las behavior/time rules se loguean una vez con POLICY_SKIPPED_BEHAVIOR_RULE
 * para hacer visible que se las omite a propósito.
 */
export async function enforcePolicy(ctx: PolicyContext): Promise<PolicyDecision> {
  const { rules, policies, reminderCount } = await loadInputs(ctx.businessId);

  if (reminderCount > 0) {
    cloudLog({
      severity: "DEBUG",
      component: "System",
      action: "POLICY_SKIPPED_BEHAVIOR_RULE",
      a2a_transfer: false,
      message: "Skipping behavior/time rules — advisory only, not enforced server-side",
      businessId: ctx.businessId,
      data: { reminderCount, actionType: ctx.action.type },
    });
  }

  const decision = evaluatePolicy(ctx, { rules, policies });

  if (decision.allowed) {
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "POLICY_DECISION",
      a2a_transfer: false,
      message: "Policy allowed",
      businessId: ctx.businessId,
      data: {
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
        actionType: ctx.action.type,
        decision: "allowed",
      },
    });
    return decision;
  }

  cloudLog({
    severity: "WARNING",
    component: "System",
    action: "POLICY_DENIED",
    a2a_transfer: false,
    message: `Policy denied: ${decision.code}`,
    businessId: ctx.businessId,
    data: {
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      actionType: ctx.action.type,
      decision: "denied",
      ruleId: decision.ruleId,
      code: decision.code,
      reason: decision.reason,
    },
  });
  return decision;
}

/** Construye la respuesta 403 estándar para un deny del motor. */
export function policyDeniedResponse(
  decision: Extract<PolicyDecision, { allowed: false }>,
): NextResponse {
  return NextResponse.json(
    {
      error: "POLICY_DENIED",
      code: decision.code,
      reason: decision.reason,
      ruleId: decision.ruleId,
      message: decision.reason,
    },
    { status: 403 },
  );
}
