import { NextRequest, NextResponse } from "next/server";
import {
  checkRateLimit,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import {
  updateBusinessRuleBodySchema,
  validateTimeTrigger,
  validateConditionTrigger,
} from "@/app/api/business/business-rules/business-rule-schema";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { prismaBusinessRuleRepository } from "@/infrastructure/persistence/prisma-business-rule.repository";
import { notifyRuleEmployees } from "@/app/api/_lib/notify-rule-employees";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { prisma } from "@/lib/prisma";

// ── PATCH /api/business/business-rules/[id] ──────────────────────────────

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return runWithTraceContext(req.headers, () => handlePatch(req, { params }));
}

async function handlePatch(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  const { id: ruleId } = await params;

  const parsed = await parseZodBody(req, updateBusinessRuleBodySchema);
  if (!parsed.ok) return parsed.response;

  const { kind, trigger, message, active } = parsed.data;
  const updates: { kind?: string; trigger?: string; message?: string; active?: boolean } = {};
  if (kind !== undefined) updates.kind = kind;
  if (trigger !== undefined) updates.trigger = trigger.trim();
  if (message !== undefined) updates.message = message.trim();
  if (active !== undefined) updates.active = active;

  // Validate trigger format when a new trigger value is provided.
  // We need the effective kind: the update value if provided, else the stored value.
  if (trigger !== undefined) {
    const existing = await prisma.businessRule.findFirst({
      where: { id: ruleId, businessId },
      select: { kind: true },
    });
    if (!existing) {
      return NextResponse.json({ code: "RULE_NOT_FOUND", message: "Rule not found." }, { status: 404 });
    }
    const effectiveKind = kind ?? existing.kind;
    let triggerError: string | null = null;
    if (effectiveKind === "time-based") {
      triggerError = validateTimeTrigger(trigger.trim());
    } else if (effectiveKind === "condition-based") {
      triggerError = validateConditionTrigger(trigger.trim());
    }
    if (triggerError !== null) {
      return NextResponse.json({ code: "INVALID_TRIGGER", message: triggerError }, { status: 422 });
    }
  }

  try {
    const updated = await prismaBusinessRuleRepository.update(businessId, ruleId, updates);
    if (!updated) {
      return NextResponse.json({ code: "RULE_NOT_FOUND", message: "Rule not found." }, { status: 404 });
    }
    await recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId: ctx.actorUserId,
      actorEmployeeId: null,
      routeScope: "business.business-rules",
      actionType: "business-rule.update",
      resourceType: "BusinessRule",
      resourceId: updated.id,
      summary: `Actualizó regla "${updated.trigger}"`,
      payload: { ruleId: updated.id, updates },
    });
    invalidateBusinessContext(businessId);
    // Only notify employees when the rule is explicitly being activated (active === true).
    // Notifying on every edit (message/kind/trigger changes) or on deactivation is noise.
    if (active === true) {
      notifyRuleEmployees(businessId, updated.id, `Regla actualizada: ${updated.message}`).catch(() => {});
    }
    return NextResponse.json({
      rule: {
        id: updated.id,
        kind: updated.kind,
        trigger: updated.trigger,
        message: updated.message,
        active: updated.active,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    logRouteError("business.business-rules.PATCH", error);
    return internalError("No se pudo actualizar la regla.");
  }
}

// ── DELETE /api/business/business-rules/[id] ─────────────────────────────

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  return runWithTraceContext(req.headers, () => handleDelete(req, { params }));
}

async function handleDelete(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  const { id: ruleId } = await params;

  try {
    const result = await prismaBusinessRuleRepository.delete(businessId, ruleId);
    if (!result.deleted) {
      return NextResponse.json({ code: "RULE_NOT_FOUND", message: "Rule not found." }, { status: 404 });
    }
    await recordCriticalWriteEvent({
      client: prisma,
      businessId,
      actorUserId: ctx.actorUserId,
      actorEmployeeId: null,
      routeScope: "business.business-rules",
      actionType: "business-rule.delete",
      resourceType: "BusinessRule",
      resourceId: ruleId,
      summary: `Eliminó regla id="${ruleId}"`,
      payload: { ruleId },
    });
    invalidateBusinessContext(businessId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    logRouteError("business.business-rules.DELETE", error);
    return internalError("No se pudo eliminar la regla.");
  }
}
