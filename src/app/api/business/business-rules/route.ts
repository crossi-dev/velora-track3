// Owner-only — CRUD de BusinessRule (reglas activas del negocio).
// El dueño puede ver / crear / modificar / borrar reglas que el supervisor
// gatilla y el companion comunica al empleado. Reglas creadas vía chat
// con el supervisor también aparecen acá.
//
// Auth: solo OWNER (resolveActor + requireRole). Empleados con PIN NO acceden.
// Multi-tenant: businessId resuelto por session, jamás por body.
//
// Note: "business-rule.create" is listed in SUPERVISOR_INTERNAL_ACTIONS in the
// guardrail scanner because the supervisor also fires this action via its own
// idempotency path. This route is the owner REST path and handles idempotency
// through the use-case (same hexagonal pattern as create-product).

import { NextRequest, NextResponse } from "next/server";
import {
  badRequest,
  checkRateLimit,
  conflict,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { createBusinessRuleBodySchema } from "./business-rule-schema";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { classifyRule } from "./_lib/classify-rule";
import { createBusinessRuleUseCase } from "@/application/use-cases/create-business-rule.use-case";
import { prismaBusinessRuleRepository } from "@/infrastructure/persistence/prisma-business-rule.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { notifyRuleEmployees } from "@/app/api/_lib/notify-rule-employees";
import { runWithTraceContext } from "@/lib/cloud-logger";

const BUSINESS_RULE_ACTION_META = {
  actionType: "business-rule.create",
  routeScope: "business/business-rules",
  resourceType: "BusinessRule",
} as const;

interface BusinessRuleRow {
  id: string;
  kind: string;
  trigger: string;
  message: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

const createBusinessRule = createBusinessRuleUseCase({
  businessRule: prismaBusinessRuleRepository,
  idempotency: prismaIdempotencyAdapter,
  classifier: classifyRule,
  audit: prismaAuditAdapter,
});

// ── GET /api/business/business-rules ─────────────────────────────────────

export async function GET(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = resolvedCtx;

  try {
    const rows = await prismaBusinessRuleRepository.list(businessId);
    const rules: BusinessRuleRow[] = rows.map((r) => ({
      id: r.id, kind: r.kind, trigger: r.trigger, message: r.message, active: r.active,
      createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    }));
    return NextResponse.json({ rules });
  } catch (error) {
    logRouteError("business.business-rules.GET", error);
    return internalError("No se pudieron cargar las reglas.");
  }
}

// ── POST /api/business/business-rules ────────────────────────────────────

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const resolvedCtx = await resolveActor(req);
  if (!resolvedCtx) return unauthorized();
  const forbidden = requireRole(resolvedCtx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId } = resolvedCtx;

  const parsed = await parseZodBody(req, createBusinessRuleBodySchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await createBusinessRule.execute({
      businessId,
      actorUserId,
      kind: parsed.data.kind,
      trigger: parsed.data.trigger,
      message: parsed.data.message,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: parsed.data,
      actionMeta: BUSINESS_RULE_ACTION_META,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta el encabezado X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Esta clave de idempotencia ya se usó para otra solicitud.");
    if (result.outcome === "idempotency_in_flight") return conflict("Esta solicitud ya se está procesando. Esperá antes de reintentar.");
    if (result.outcome === "invalid_trigger") {
      return NextResponse.json(
        { code: "INVALID_TRIGGER", message: result.message },
        { status: 422 },
      );
    }
    if (result.outcome === "duplicate_trigger") {
      return NextResponse.json(
        { code: "DUPLICATE_TRIGGER", message: "A rule with this trigger already exists.", existingId: result.existingId },
        { status: 409 },
      );
    }
    if (result.outcome !== "created") return internalError("No se pudo crear la regla.");

    const rule: BusinessRuleRow = {
      id: result.rule.id, kind: result.rule.kind, trigger: result.rule.trigger,
      message: result.rule.message, active: result.rule.active,
      createdAt: result.rule.createdAt.toISOString(), updatedAt: result.rule.updatedAt.toISOString(),
    };
    invalidateBusinessContext(businessId);
    notifyRuleEmployees(businessId, result.rule.id, `Nueva regla: ${result.rule.message}`).catch(() => {});
    return NextResponse.json({ rule }, { status: 201 });
  } catch (error) {
    logRouteError("business.business-rules.POST", error);
    return internalError("No se pudo crear la regla.");
  }
}
