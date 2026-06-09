// Ejecuta create/update/delete_business_rule emitidas por el Supervisor (Gemini Pro).
// Persiste como fila en BusinessRule. Solo el dueño OAuth puede emitirlas (RBAC en el caller).
// Idempotencia best-effort: create con (businessId, trigger) — trigger duplicado → update implícito.
// Errores se devuelven como string `error` — NUNCA tira (fail-soft).
//
// Sello: ALL three use-cases own their idempotency seal (begin/complete/release).
// withSupervisorContractGuards is NOT used for any of these paths to avoid double-begin (P2002).
// Create uses createBusinessRuleUseCase with allowUpsertByTrigger=true for upsert semantics.

import { reportWarning } from "@/lib/cloud-logger";
import { notifyRuleEmployees } from "@/app/api/_lib/notify-rule-employees";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import { prismaBusinessRuleRepository } from "@/infrastructure/persistence/prisma-business-rule.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { createBusinessRuleUseCase } from "@/application/use-cases/create-business-rule.use-case";
import { updateBusinessRuleUseCase } from "@/application/use-cases/update-business-rule.use-case";
import { deleteBusinessRuleUseCase } from "@/application/use-cases/delete-business-rule.use-case";
import {
  deriveSupervisorIdempotencyKey as deriveIdempotencyKey,
  isValidCronExpression,
} from "./contract-helpers";
import { assertDemoQuota } from "@/app/api/_lib/demo-quota";
import { invalidateSupervisorContext } from "./load-context";

const RULE_CREATE_ACTION = getServerActionMeta("business-rule.create");
const RULE_UPDATE_ACTION = getServerActionMeta("business-rule.update");
const RULE_DELETE_ACTION = getServerActionMeta("business-rule.delete");

export type RuleKind = "time-based" | "condition-based" | "behavior-based";

export interface SupervisorAction {
  intent: string;
  data?: unknown;
  summary?: string;
}

export interface RuleActionResult {
  /** Confirmación human-readable para mostrar al dueño en el chat. */
  confirmation: string | null;
  /** Mensaje de error (si algo falló). null si todo OK. */
  error: string | null;
  /** Cantidad de filas afectadas en BusinessRule. */
  affected: number;
}

const VALID_KINDS: ReadonlySet<RuleKind> = new Set(["time-based", "condition-based", "behavior-based"]);
const CRON_ERROR = `No entendí el horario. El trigger de reglas programadas debe ser un cron de 5 campos (ej: "0 9 * * 1" = lunes 9am, "0 9 * * 1-5" = lun-vie 9am, "*/30 * * * *" = cada 30 min). Describime mejor cuándo querés la alerta.`;

function isString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/**
 * Determina si una action del supervisor es de tipo business_rule.
 * Retorna el sub-intent específico o null si no aplica.
 */
export function isBusinessRuleAction(action: SupervisorAction): "create" | "update" | "delete" | null {
  if (action.intent === "create_business_rule") return "create";
  if (action.intent === "update_business_rule") return "update";
  if (action.intent === "delete_business_rule") return "delete";
  return null;
}

/**
 * Ejecuta UNA action de tipo business_rule contra la DB.
 * Reusable desde cualquier flow que llame al supervisor (business-assistant
 * route en B1/B2 paths, supervisor route directo, etc).
 */
export async function executeRuleAction(
  action: SupervisorAction,
  businessId: string,
  actorUserId: string,
  idempotencySeed: string,
): Promise<RuleActionResult> {
  const sub = isBusinessRuleAction(action);
  if (!sub) {
    return { confirmation: null, error: "not a business_rule action", affected: 0 };
  }

  const data = asObject(action.data);
  if (!data) {
    return { confirmation: null, error: `${action.intent} sin data válida`, affected: 0 };
  }

  try {
    if (sub === "create") {
      const kind = data.kind;
      const trigger = data.trigger;
      const message = data.message;
      if (!isString(kind) || !VALID_KINDS.has(kind as RuleKind)) {
        return { confirmation: null, error: "kind inválido (esperado time-based / condition-based / behavior-based)", affected: 0 };
      }
      if (!isString(trigger) || !isString(message)) {
        return { confirmation: null, error: "trigger y message son requeridos para create_business_rule", affected: 0 };
      }
      if (kind === "time-based" && !isValidCronExpression(trigger)) {
        return { confirmation: null, error: CRON_ERROR, affected: 0 };
      }
      const idempotencyKey = deriveIdempotencyKey(idempotencySeed, action.intent, data);
      // Use-case owns idempotency — do NOT wrap in withContractGuards (double-begin guard).
      // allowUpsertByTrigger=true gives the supervisor its upsert-by-trigger semantics;
      // route.ts never passes this flag and never sees outcome "upserted".
      const createUseCase = createBusinessRuleUseCase({
        businessRule: prismaBusinessRuleRepository,
        idempotency: prismaIdempotencyAdapter,
        classifier: async () => ({ kind: kind as RuleKind, cron: null }),
        audit: prismaAuditAdapter,
        assertDemoQuota,
        notifyRuleEmployees,
        invalidateSupervisorContext,
      });
      const result = await createUseCase.execute({
        businessId,
        actorUserId,
        kind: kind as RuleKind,
        trigger,
        message,
        idempotencyKey,
        requestBody: { kind, trigger, message },
        actionMeta: {
          actionType: RULE_CREATE_ACTION.actionType,
          routeScope: RULE_CREATE_ACTION.routeScope,
          resourceType: RULE_CREATE_ACTION.resourceType,
        },
        allowUpsertByTrigger: true,
      });
      if (result.outcome === "demo_limit_reached") return { confirmation: null, error: null, affected: 0 };
      if (result.outcome === "invalid_trigger") return { confirmation: null, error: result.message, affected: 0 };
      if (result.outcome === "replayed" || result.outcome === "idempotency_missing" ||
          result.outcome === "idempotency_conflict" || result.outcome === "idempotency_in_flight") {
        return { confirmation: null, error: null, affected: 0 };
      }
      if (result.outcome === "upserted") {
        return {
          confirmation: `Regla actualizada (ya existía un trigger igual): ${action.summary ?? trigger}`,
          error: null,
          affected: 1,
        };
      }
      if (result.outcome === "created") {
        return {
          confirmation: action.summary ? `Listo, ${action.summary.toLowerCase()}.` : `Regla creada: ${trigger}`,
          error: null,
          affected: 1,
        };
      }
      return { confirmation: null, error: null, affected: 0 };
    }

    if (sub === "update") {
      const ruleTrigger = data.ruleTrigger;
      if (!isString(ruleTrigger)) {
        return { confirmation: null, error: "ruleTrigger requerido para update_business_rule", affected: 0 };
      }
      // Build updates map from input data — validate before opening idempotency envelope.
      const updates: { kind?: string; trigger?: string; message?: string; active?: boolean } = {};
      if (isString(data.kind) && VALID_KINDS.has(data.kind as RuleKind)) updates.kind = data.kind as string;
      if (isString(data.trigger)) {
        // Bug1 fix: cron validation now runs inside the use-case using the rule's STORED kind
        // (via findByTrigger returning {id, kind}). No pre-validation here avoids the bug where
        // this code defaulted to "behavior-based" instead of using the actual stored kind.
        updates.trigger = data.trigger as string;
      }
      if (isString(data.message)) updates.message = data.message as string;
      if (typeof data.active === "boolean") updates.active = data.active;
      if (Object.keys(updates).length === 0) {
        return { confirmation: null, error: "update_business_rule sin cambios efectivos", affected: 0 };
      }
      const idempotencyKey = deriveIdempotencyKey(idempotencySeed, action.intent, { ruleTrigger, updates });
      // Use-case owns idempotency — do NOT wrap in withContractGuards (double-begin guard).
      const useCase = updateBusinessRuleUseCase({
        businessRule: prismaBusinessRuleRepository,
        idempotency: prismaIdempotencyAdapter,
        audit: prismaAuditAdapter,
        notifyRuleEmployees,
        invalidateSupervisorContext,
        assertDemoQuota,
      });
      const result = await useCase.execute({
        businessId,
        actorUserId,
        ruleTrigger,
        updates,
        idempotencyKey,
        requestBody: { ruleTrigger, updates },
        actionMeta: {
          actionType: RULE_UPDATE_ACTION.actionType,
          routeScope: RULE_UPDATE_ACTION.routeScope,
          resourceType: RULE_UPDATE_ACTION.resourceType,
        },
      });
      if (result.outcome === "not_found") return { confirmation: null, error: `No encontré una regla con trigger="${ruleTrigger}"`, affected: 0 };
      if (result.outcome === "cron_invalid") return { confirmation: null, error: CRON_ERROR, affected: 0 };
      if (result.outcome === "demo_limit_reached") return { confirmation: null, error: null, affected: 0 };
      if (result.outcome !== "updated") return { confirmation: null, error: null, affected: 0 };
      return {
        confirmation: action.summary ? `Listo, ${action.summary.toLowerCase()}.` : `Regla actualizada: ${ruleTrigger}`,
        error: null,
        affected: 1,
      };
    }

    // delete (soft — flips active=false via port.update, not port.delete)
    const ruleTrigger = data.ruleTrigger;
    if (!isString(ruleTrigger)) {
      return { confirmation: null, error: "ruleTrigger requerido para delete_business_rule", affected: 0 };
    }
    const idempotencyKey = deriveIdempotencyKey(idempotencySeed, action.intent, { ruleTrigger });
    // Use-case owns idempotency — do NOT wrap in withContractGuards (double-begin guard).
    const delUseCase = deleteBusinessRuleUseCase({
      businessRule: prismaBusinessRuleRepository,
      idempotency: prismaIdempotencyAdapter,
      audit: prismaAuditAdapter,
      invalidateSupervisorContext,
      assertDemoQuota,
    });
    const delResult = await delUseCase.execute({
      businessId,
      actorUserId,
      ruleTrigger,
      idempotencyKey,
      requestBody: { ruleTrigger },
      actionMeta: {
        actionType: RULE_DELETE_ACTION.actionType,
        routeScope: RULE_DELETE_ACTION.routeScope,
        resourceType: RULE_DELETE_ACTION.resourceType,
      },
    });
    if (delResult.outcome === "not_found") return { confirmation: null, error: `No encontré una regla con trigger="${ruleTrigger}"`, affected: 0 };
    if (delResult.outcome === "demo_limit_reached") return { confirmation: null, error: null, affected: 0 };
    if (delResult.outcome !== "deleted") return { confirmation: null, error: null, affected: 0 };
    return {
      confirmation: action.summary ? `Listo, ${action.summary.toLowerCase()}.` : `Regla desactivada: ${ruleTrigger}`,
      error: null,
      affected: delResult.count,
    };
  } catch (err) {
    reportWarning("[business-rule-actions] DB write failed", { scope: "business-rule-actions", subIntent: sub, businessId, error: err instanceof Error ? err.message : String(err) });
    return {
      confirmation: null,
      error: err instanceof Error ? err.message : "Error desconocido al persistir la regla",
      affected: 0,
    };
  }
}

/**
 * Ejecuta TODAS las actions de tipo business_rule en una lista. Las que no
 * sean de ese tipo se ignoran (las puede ejecutar otro handler downstream).
 * Retorna un texto agregado para mostrar al dueño con todas las confirmaciones
 * y/o errores concatenados.
 */
export async function executeRuleActions(
  actions: ReadonlyArray<SupervisorAction>,
  businessId: string,
  actorUserId: string,
  idempotencySeed: string,
): Promise<{
  confirmations: string[];
  errors: string[];
  totalAffected: number;
  ruleActionCount: number;
}> {
  const confirmations: string[] = [];
  const errors: string[] = [];
  let totalAffected = 0;
  let ruleActionCount = 0;
  for (const action of actions) {
    if (!isBusinessRuleAction(action)) continue;
    const result = await executeRuleAction(action, businessId, actorUserId, `${idempotencySeed}|${ruleActionCount}`);
    ruleActionCount += 1;
    if (result.confirmation) confirmations.push(result.confirmation);
    if (result.error) errors.push(result.error);
    totalAffected += result.affected;
  }
  return { confirmations, errors, totalAffected, ruleActionCount };
}

/** Combina confirmaciones + errores en un solo string para concatenar al
 *  answer del supervisor. Si no hubo nada que reportar, retorna null. */
export function summarizeRuleResults(results: {
  confirmations: string[];
  errors: string[];
  ruleActionCount: number;
}): string | null {
  if (results.ruleActionCount === 0) return null;
  const parts: string[] = [];
  if (results.confirmations.length > 0) parts.push(...results.confirmations);
  if (results.errors.length > 0) parts.push(...results.errors.map((e) => `Error: ${e}`));
  if (parts.length === 0) return null;
  return parts.join(" ");
}
