import { NextRequest, NextResponse } from "next/server";
import {
  checkRateLimit,
  bypassIfTester,
  internalError,
  logRouteError,
  unauthorized,
  badRequest,
  conflict,
} from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { createCashMovementBodySchema } from "./cash-movement-schema";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { normalizeInput } from "@/lib/normalize";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { createCashMovementUseCase } from "@/application/use-cases/create-cash-movement.use-case";
import type { CashMovementType } from "@/domain/ports/cash-movement.repository.port";
import { prismaCashMovementRepository } from "@/infrastructure/persistence/prisma-cash-movement.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";

const MUTATION_ACTIONS = {
  POST: "cash-movement.create",
} as const satisfies RouteMutationDeclaration;
const ACTION_META = getServerActionMeta(MUTATION_ACTIONS.POST);

const cashMovementUseCase = createCashMovementUseCase({
  cashMovements: prismaCashMovementRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  try {
    const parsed = await parseZodBody(req, createCashMovementBodySchema);
    if (!parsed.ok) return parsed.response;

    const type = normalizeInput(parsed.data.type) as CashMovementType;
    const description = normalizeInput(parsed.data.description);
    const amount = parsed.data.amount;
    const date = parsed.data.date ? new Date(parsed.data.date) : new Date();

    const idempotencyKey = getIdempotencyKey(req);
    const result = await cashMovementUseCase.execute({
      businessId,
      actorUserId,
      actorEmployeeId,
      type,
      description,
      amount,
      date,
      idempotencyKey,
      actionMeta: ACTION_META,
      requestBody: parsed.data,
      // Forward key as clientMessageId so the DB partial unique index enforces dedup
      // even when IdempotencyRecord is bypassed by a retry from a different client.
      // idempotency_missing outcome fires first when the header is absent, so this
      // is always a non-null string by the time it reaches createCashMovementInTransaction.
      clientMessageId: idempotencyKey || null,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "demo_limit_reached") return NextResponse.json({ code: "DEMO_LIMIT_REACHED", message: result.message }, { status: 403 });
    if (result.outcome === "idempotency_missing") return badRequest("Falta el encabezado X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Esta clave de idempotencia ya se usó para otra solicitud.");
    if (result.outcome === "idempotency_in_flight") return conflict("Esta solicitud ya se está procesando. Esperá antes de reintentar.");

    invalidateBusinessContext(businessId);
    return NextResponse.json(
      { movement: result.movement, ...(result.signCorrected ? { signCorrected: true } : {}) },
      { status: 201 }
    );
  } catch (error) {
    logRouteError("cash-movements", error);
    return internalError("No se pudo guardar el movimiento de caja.");
  }
}
