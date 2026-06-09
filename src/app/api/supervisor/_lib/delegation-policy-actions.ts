import { prisma } from "@/lib/prisma";
import { reportWarning } from "@/lib/cloud-logger";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import {
  deriveSupervisorIdempotencyKey as deriveIdempotencyKey,
  withSupervisorContractGuards as withContractGuards,
  isDemoLimitReached,
} from "./contract-helpers";
import { invalidateSupervisorContext } from "./load-context";
import type { SupervisorAction } from "./business-rule-actions";

const POLICY_CREATE_ACTION = getServerActionMeta("delegation-policy.create");
const POLICY_UPDATE_ACTION = getServerActionMeta("delegation-policy.update");
const POLICY_DELETE_ACTION = getServerActionMeta("delegation-policy.delete");

export type PolicyScope = "stock" | "sale" | "return";

const VALID_SCOPES: ReadonlySet<PolicyScope> = new Set(["stock", "sale", "return"]);

function isString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

export interface PolicyActionResult {
  confirmation: string | null;
  error: string | null;
}

export function isDelegationPolicyAction(action: SupervisorAction): boolean {
  return (
    action.intent === "create_delegation_policy" ||
    action.intent === "update_delegation_policy" ||
    action.intent === "delete_delegation_policy"
  );
}

export async function executePolicyAction(
  action: SupervisorAction,
  businessId: string,
  actorUserId: string,
  idempotencySeed: string,
): Promise<PolicyActionResult> {
  if (!isDelegationPolicyAction(action)) {
    return { confirmation: null, error: "not a delegation_policy action" };
  }

  const data = asObject(action.data);
  if (!data) {
    return { confirmation: null, error: `${action.intent} sin data válida` };
  }

  try {
    if (action.intent === "create_delegation_policy") {
      const scope = data.scope;
      if (!isString(scope) || !VALID_SCOPES.has(scope as PolicyScope)) {
        return { confirmation: null, error: "scope inválido (stock | sale | return)" };
      }
      const maxValue = typeof data.maxValue === "number" ? data.maxValue : null;
      const requiresOwner = data.requiresOwner === true;
      const conditions = isString(data.conditions) ? data.conditions : "{}";

      const existing = await prisma.delegationPolicy.findFirst({
        where: { businessId, scope, active: true },
        select: { id: true },
      });
      const idempotencyKey = deriveIdempotencyKey(idempotencySeed, action.intent, { scope, maxValue, requiresOwner, conditions });
      const guarded = await withContractGuards({
        actionType: POLICY_CREATE_ACTION.actionType,
        routeScope: POLICY_CREATE_ACTION.routeScope,
        resourceType: POLICY_CREATE_ACTION.resourceType,
        businessId,
        actorUserId,
        idempotencyKey,
        requestBody: { scope, maxValue, requiresOwner, conditions },
        summaryFor: (res: { policyId: string; wasExisting: boolean }) => ({
          summary: res.wasExisting ? `Perímetro "${scope}" actualizado (existía)` : `Perímetro "${scope}" creado`,
          resourceId: res.policyId,
          payload: { scope, maxValue, requiresOwner, conditions, wasExisting: res.wasExisting },
        }),
        exec: async () => {
          if (existing) {
            await prisma.delegationPolicy.update({
              where: { id: existing.id },
              data: { maxValue, requiresOwner, conditions, active: true },
            });
            invalidateSupervisorContext(businessId);
            return { policyId: existing.id, wasExisting: true };
          }
          const created = await prisma.delegationPolicy.create({
            data: { businessId, scope, maxValue, requiresOwner, conditions, active: true },
            select: { id: true },
          });
          invalidateSupervisorContext(businessId);
          return { policyId: created.id, wasExisting: false };
        },
      });
      if ("skipped" in guarded) return { confirmation: null, error: null };
      if (isDemoLimitReached(guarded)) return { confirmation: null, error: guarded.message };
      return {
        confirmation: action.summary
          ? `Listo, ${action.summary.toLowerCase()}.`
          : guarded.value.wasExisting ? `Perímetro "${scope}" actualizado.` : `Perímetro "${scope}" creado.`,
        error: null,
      };
    }

    if (action.intent === "update_delegation_policy") {
      const scope = data.scope;
      if (!isString(scope)) {
        return { confirmation: null, error: "scope requerido para update_delegation_policy" };
      }
      const existing = await prisma.delegationPolicy.findFirst({
        where: { businessId, scope, active: true },
        select: { id: true },
      });
      if (!existing) {
        return { confirmation: null, error: `No encontré perímetro activo para scope="${scope}"` };
      }
      const updates: Record<string, unknown> = {};
      if (typeof data.maxValue === "number" || data.maxValue === null) updates.maxValue = data.maxValue;
      if (typeof data.requiresOwner === "boolean") updates.requiresOwner = data.requiresOwner;
      if (isString(data.conditions)) updates.conditions = data.conditions;
      if (Object.keys(updates).length === 0) {
        return { confirmation: null, error: "update_delegation_policy sin cambios efectivos" };
      }
      const idempotencyKey = deriveIdempotencyKey(idempotencySeed, action.intent, { scope, updates });
      const guarded = await withContractGuards({
        actionType: POLICY_UPDATE_ACTION.actionType,
        routeScope: POLICY_UPDATE_ACTION.routeScope,
        resourceType: POLICY_UPDATE_ACTION.resourceType,
        businessId,
        actorUserId,
        idempotencyKey,
        requestBody: { scope, updates },
        summaryFor: () => ({
          summary: `Perímetro "${scope}" actualizado`,
          resourceId: existing.id,
          payload: { policyId: existing.id, updates },
        }),
        exec: async () => {
          await prisma.delegationPolicy.update({ where: { id: existing.id }, data: updates });
          invalidateSupervisorContext(businessId);
        },
      });
      if ("skipped" in guarded) return { confirmation: null, error: null };
      if (isDemoLimitReached(guarded)) return { confirmation: null, error: guarded.message };
      return {
        confirmation: action.summary ? `Listo, ${action.summary.toLowerCase()}.` : `Perímetro "${scope}" actualizado.`,
        error: null,
      };
    }

    // delete (soft) — modelado contractualmente como un update con active=false
    const scope = data.scope;
    if (!isString(scope)) {
      return { confirmation: null, error: "scope requerido para delete_delegation_policy" };
    }
    const idempotencyKey = deriveIdempotencyKey(idempotencySeed, action.intent, { scope });
    const guarded = await withContractGuards({
      actionType: POLICY_DELETE_ACTION.actionType,
      routeScope: POLICY_DELETE_ACTION.routeScope,
      resourceType: POLICY_DELETE_ACTION.resourceType,
      businessId,
      actorUserId,
      idempotencyKey,
      requestBody: { scope, op: "soft-delete" },
      summaryFor: (res: { count: number }) => ({
        summary: `Perímetro "${scope}" eliminado (soft)`,
        resourceId: null,
        payload: { scope, count: res.count },
      }),
      exec: async () => {
        const result = await prisma.delegationPolicy.updateMany({
          where: { businessId, scope, active: true },
          data: { active: false },
        });
        invalidateSupervisorContext(businessId);
        return { count: result.count };
      },
    });
    if ("skipped" in guarded) return { confirmation: null, error: null };
    if (isDemoLimitReached(guarded)) return { confirmation: null, error: guarded.message };
    if (guarded.value.count === 0) {
      return { confirmation: null, error: `No encontré perímetro activo para scope="${scope}"` };
    }
    return {
      confirmation: action.summary ? `Listo, ${action.summary.toLowerCase()}.` : `Perímetro "${scope}" eliminado.`,
      error: null,
    };
  } catch (err) {
    reportWarning("[delegation-policy-actions] DB write failed", { scope: "delegation-policy-actions", intent: action.intent, businessId, error: err instanceof Error ? err.message : String(err) });
    return {
      confirmation: null,
      error: err instanceof Error ? err.message : "Error desconocido al persistir el perímetro",
    };
  }
}

export async function executePolicyActions(
  actions: ReadonlyArray<SupervisorAction>,
  businessId: string,
  actorUserId: string,
  idempotencySeed: string,
): Promise<{ confirmations: string[]; errors: string[] }> {
  const confirmations: string[] = [];
  const errors: string[] = [];
  let idx = 0;
  for (const action of actions) {
    if (!isDelegationPolicyAction(action)) continue;
    const result = await executePolicyAction(action, businessId, actorUserId, `${idempotencySeed}|${idx}`);
    idx += 1;
    if (result.confirmation) confirmations.push(result.confirmation);
    if (result.error) errors.push(result.error);
  }
  return { confirmations, errors };
}
