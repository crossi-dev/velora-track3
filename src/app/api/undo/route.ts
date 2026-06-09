import { z } from "zod";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { parseZodBody } from "@/app/api/_lib/zod-body";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { getIdempotencyKey } from "@/app/api/_lib/idempotency";
import { getServerActionMeta, type RouteMutationDeclaration } from "@/app/api/_lib/mutation-contract";
import { prismaIdempotencyAdapter } from "@/infrastructure/persistence/prisma-idempotency.adapter";
import { PRODUCT_HAS_SALE_ITEMS_ERROR } from "./_lib/undo-product-create";
import { dispatchUndo } from "./_lib/undo-dispatcher";
import type { UndoHandlerContext } from "./_lib/undo-handler-context";
import { enforcePolicy, policyDeniedResponse } from "@/app/api/_lib/policy-evaluator";
import { runWithTraceContext } from "@/lib/cloud-logger";

const undoBodySchema = z.object({
  target: z.enum(["sale", "customer", "stock", "product", "supplier", "cash-movement", "product-create"]),
  count: z.number().int().positive().max(10).optional(),
  stockMovementIds: z.array(z.string().min(1)).optional(),
  productId: z.string().optional(),
}).strict();

const MUTATION_ACTIONS = {
  POST: "undo.execute",
} as const satisfies RouteMutationDeclaration;
const UNDO_EXECUTE_ACTION = getServerActionMeta(MUTATION_ACTIONS.POST);

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId, actorUserId } = ctx;
  let idempotencyRecordId: string | null = null;

  try {
    const parsedBody = await parseZodBody(req, undoBodySchema);
    if (!parsedBody.ok) return parsedBody.response;
    const { target: safeTarget, count = 1, stockMovementIds, productId } = parsedBody.data;
    const safeCount = Math.min(count, 10);
    const anchoredStockIds = stockMovementIds ?? [];

    if (safeTarget === "sale") {
      const policyDecision = await enforcePolicy({
        businessId,
        actorId: actorUserId,
        actorRole: ctx.role,
        action: { type: "return-sale", data: { count: safeCount } },
      });
      if (!policyDecision.allowed) return policyDeniedResponse(policyDecision);
    }

    const idempotency = await prismaIdempotencyAdapter.begin({
      businessId,
      actionType: UNDO_EXECUTE_ACTION.actionType,
      idempotencyKey: getIdempotencyKey(req),
      requestBody: { target: safeTarget, count: safeCount },
    });

    if (idempotency.kind === "replay") return NextResponse.json(idempotency.body, { status: idempotency.status });
    if (idempotency.kind !== "execute") return NextResponse.json({ code: "IDEMPOTENCY_ERROR", message: "Idempotency check failed." }, { status: 422 });

    idempotencyRecordId = idempotency.recordId;

    const releaseAndReturnError = async (body: Record<string, unknown>, status: number) => {
      await prismaIdempotencyAdapter.release(idempotencyRecordId);
      return NextResponse.json(body, { status });
    };

    const undoCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const undoCtx: UndoHandlerContext = {
      businessId,
      userId: actorUserId,
      safeCount,
      anchoredStockIds,
      productId,
      idempotencyRecordId: idempotencyRecordId!,
      routeScope: UNDO_EXECUTE_ACTION.routeScope,
      undoCutoff,
      releaseAndReturnError,
    };

    return await dispatchUndo(safeTarget, undoCtx);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("STOCK_UNDO_CONFLICT:")) {
      const productName = error.message.slice("STOCK_UNDO_CONFLICT:".length) || "item";
      await prismaIdempotencyAdapter.release(idempotencyRecordId);
      return NextResponse.json(
        { code: "STOCK_UNDO_CONFLICT", message: `Cannot undo that stock load because ${productName} no longer has sufficient stock.` },
        { status: 409 }
      );
    }

    if (error instanceof Error && error.message === PRODUCT_HAS_SALE_ITEMS_ERROR) {
      await prismaIdempotencyAdapter.release(idempotencyRecordId);
      return NextResponse.json(
        { code: "PRODUCT_HAS_SALES", message: "Cannot undo: the product already has recorded sales." },
        { status: 409 }
      );
    }

    await prismaIdempotencyAdapter.release(idempotencyRecordId);
    logRouteError("undo", error, {
      businessId,
      actionType: UNDO_EXECUTE_ACTION.actionType,
    });
    return NextResponse.json({ code: "UNDO_FAILED", message: "Internal server error." }, { status: 500 });
  }
}
