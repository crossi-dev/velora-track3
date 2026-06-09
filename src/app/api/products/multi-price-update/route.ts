import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimit,
  internalError,
  logRouteError,
  unauthorized,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { multiPriceUpdateBodySchema } from "./multi-price-update-schema";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { multiPriceUpdateUseCase } from "@/application/use-cases/multi-price-update.use-case";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";
import { prismaProductRepository } from "@/infrastructure/persistence/prisma-product.repository";
import { runWithTraceContext } from "@/lib/cloud-logger";

const MUTATION_ACTIONS = {
  POST: "product.multi-price-update",
} as const satisfies RouteMutationDeclaration;
const ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

const useCase = multiPriceUpdateUseCase({
  product: prismaProductRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

// ── POST /api/products/multi-price-update ────────────────────────────────────

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
    const parsedBody = await parseZodBody(req, multiPriceUpdateBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const { items } = parsedBody.data;

    const result = await useCase.execute({
      businessId,
      actorUserId,
      actorEmployeeId,
      items,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: parsedBody.data,
      actionMeta: ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return internalError("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return internalError("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return internalError("Operación en curso.");
    if (result.outcome === "no_valid_items")
      return NextResponse.json(
        { code: "NO_VALID_ITEMS", message: "No valid items to update." },
        { status: 400 }
      );
    if (result.outcome !== "updated") return internalError("No se pudieron actualizar los precios.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ updated: result.count, summary: result.summary });
  } catch (error) {
    logRouteError("products/multi-price-update", error);
    return internalError("No se pudieron actualizar los precios.");
  }
}
