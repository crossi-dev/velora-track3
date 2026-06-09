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
import { bulkPriceUpdateBodySchema } from "./bulk-price-update-schema";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { bulkUpdateProductPricesUseCase } from "@/application/use-cases/bulk-update-product-prices.use-case";
import { prismaProductRepository } from "@/infrastructure/persistence/prisma-product.repository";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { prismaAuditAdapter } from "@/infrastructure/persistence/prisma-audit.adapter";
import { prismaTransactionAdapter } from "@/infrastructure/persistence/prisma-transaction.adapter";
import { enforcePolicy, policyDeniedResponse } from "@/app/api/_lib/policy-evaluator";
import { runWithTraceContext } from "@/lib/cloud-logger";

const MUTATION_ACTIONS = {
  POST: "product.bulk-price-update",
} as const satisfies RouteMutationDeclaration;
const ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

const bulkPriceUseCase = bulkUpdateProductPricesUseCase({
  product: prismaProductRepository,
  idempotency: prismaIdempotencyAdapter,
  audit: prismaAuditAdapter,
  transaction: prismaTransactionAdapter,
});

// ── POST /api/products/bulk-price-update ──────────────────────────────────

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
    const parsedBody = await parseZodBody(req, bulkPriceUpdateBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const { amount, mode, direction, productIds } = parsedBody.data;

    const policyDecision = await enforcePolicy({
      businessId,
      actorId: actorEmployeeId ?? actorUserId,
      actorRole: ctx.role,
      action: { type: "bulk-price-update", data: { amount, mode, direction } },
    });
    if (!policyDecision.allowed) return policyDeniedResponse(policyDecision);

    const normalizedProductIds = productIds
      ? Array.from(new Set(productIds))
      : [];

    const result = await bulkPriceUseCase.execute({
      businessId,
      actorUserId,
      actorEmployeeId,
      amount,
      mode,
      direction,
      productIds: normalizedProductIds,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: parsedBody.data,
      actionMeta: ACTION,
    });

    if (result.outcome === "replayed") return NextResponse.json(result.body, { status: result.status });
    if (result.outcome === "idempotency_missing") return internalError("Falta X-Idempotency-Key.");
    if (result.outcome === "idempotency_conflict") return internalError("Conflicto de idempotencia.");
    if (result.outcome === "idempotency_in_flight") return internalError("Operación en curso.");
    if (result.outcome === "no_products")
      return NextResponse.json({ code: "NO_PRODUCTS", message: "No products found to update." }, { status: 400 });
    if (result.outcome !== "updated") return internalError("No se pudieron actualizar los precios.");

    invalidateBusinessContext(businessId);
    return NextResponse.json({ updated: result.count, summary: result.summary });
  } catch (error) {
    logRouteError("products/bulk-price-update", error);
    return internalError("No se pudieron actualizar los precios.");
  }
}
