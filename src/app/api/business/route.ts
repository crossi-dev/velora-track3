import { NextRequest, NextResponse } from "next/server";
import { badRequest, checkRateLimit, conflict, internalError, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { businessUpdateSchema } from "./business-schema";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { updateBusinessUseCase } from "@/application/use-cases/update-business.use-case";
import { prismaBusinessRepository } from "@/infrastructure/persistence/prisma-business.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";

const MUTATION_ACTIONS = {
  PATCH: "business.update",
} as const satisfies RouteMutationDeclaration;
const BUSINESS_UPDATE_ACTION = getServerActionMeta(MUTATION_ACTIONS.PATCH);

const businessUpdateUseCase = updateBusinessUseCase({
  business: prismaBusinessRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

export async function PATCH(req: NextRequest) {
  // Resolve actor first so we can key the rate limiter by businessId, not IP.
  // Avoids CGNAT collisions on mobile AR networks.
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId, actorEmployeeId } = ctx;

  const rateLimited = checkRateLimit(req, "business-update", 20, 60, { actorKey: businessId });
  if (rateLimited) return rateLimited;

  const parsed = await parseZodBody(req, businessUpdateSchema);
  if (!parsed.ok) return parsed.response;

  try {
    const result = await businessUpdateUseCase.execute({
      businessId, actorUserId, actorEmployeeId,
      body: parsed.data,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: parsed.data,
      actionMeta: BUSINESS_UPDATE_ACTION,
    });

    if (result.outcome === "not_found") return NextResponse.json({ code: "BUSINESS_NOT_FOUND", message: "Business not found." }, { status: 404 });
    if (result.outcome === "missing_name") return NextResponse.json({ code: "MISSING_BUSINESS_NAME", message: "Business name is required." }, { status: 400 });
    if (result.outcome === "missing_type") return NextResponse.json({ code: "MISSING_BUSINESS_TYPE", message: "Business type is required." }, { status: 400 });
    if (result.outcome === "invalid_tax_rate") return NextResponse.json({ code: "INVALID_TAX_RATE", message: "Tax rate must be a number greater than or equal to zero." }, { status: 400 });
    if (result.outcome === "invalid_cuit") return NextResponse.json({ code: "INVALID_CUIT", message: "CUIT format is invalid (expected XX-XXXXXXXX-X)." }, { status: 400 });
    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return badRequest("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return conflict("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return conflict("Operación en curso.");
    if (result.outcome !== "updated") return internalError("Failed to update business.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ ok: true, business: result.business });
  } catch (error) {
    logRouteError("business", error);
    return NextResponse.json({ code: "BUSINESS_UPDATE_FAILED", message: "Failed to update business." }, { status: 500 });
  }
}
