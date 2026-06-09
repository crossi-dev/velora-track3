import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { undoStockBatchInTransaction } from "../undo-stock";
import type { UndoHandlerContext } from "../undo-handler-context";

export async function handleUndoStock(ctx: UndoHandlerContext): Promise<NextResponse> {
  const {
    businessId,
    userId,
    safeCount,
    anchoredStockIds,
    idempotencyRecordId,
    routeScope,
    undoCutoff,
    releaseAndReturnError,
  } = ctx;

  const movements = anchoredStockIds.length > 0
    ? await prisma.stockMovement.findMany({
        where: {
          id: { in: anchoredStockIds },
          businessId,
          reason: "stock_load",
          delta: { gt: 0 },
          createdAt: { gte: undoCutoff },
        },
        select: {
          id: true,
          productId: true,
          productName: true,
          delta: true,
          referenceId: true,
        },
      })
    : await prisma.stockMovement.findMany({
        where: {
          businessId,
          reason: "stock_load",
          delta: { gt: 0 },
          createdAt: { gte: undoCutoff },
        },
        orderBy: { createdAt: "desc" },
        take: safeCount,
        select: {
          id: true,
          productId: true,
          productName: true,
          delta: true,
          referenceId: true,
        },
      });

  if (movements.length === 0) {
    return releaseAndReturnError({ error: "No hay cargas de stock para deshacer." }, 404);
  }

  // productId is nullable post-cascade migration; filter movements whose product
  // was deleted — there is no inventory row to restore stock into.
  const restorable = movements.filter(
    (m): m is typeof m & { productId: string } => m.productId !== null
  );

  if (restorable.length === 0) {
    return releaseAndReturnError({ error: "No hay cargas de stock para deshacer." }, 404);
  }

  // Audit row is written INSIDE the same transaction as the side-effects,
  // matching the undo.sale pattern. If the audit write fails the tx rolls back
  // and no stock mutation is committed — no partial undo, no orphan audit.
  const undone = await prisma.$transaction(async (tx) => {
    const labels = await undoStockBatchInTransaction(tx as unknown as Prisma.TransactionClient, {
      businessId,
      movements: restorable,
      idempotencyRecordId,
    });
    await recordCriticalWriteEvent({
      client: tx,
      businessId,
      actorUserId: userId,
      routeScope,
      actionType: "undo.stock",
      resourceType: "stock-load",
      resourceId: movements.map((movement) => movement.id).join(","),
      summary: `${movements.length} carga${movements.length === 1 ? "" : "s"} de stock deshecha${movements.length === 1 ? "" : "s"}`,
      payload: {
        movementIds: movements.map((movement) => movement.id),
        undone: labels,
        deletedCount: movements.length,
      },
    });
    return labels;
  });

  return NextResponse.json({ deleted: movements.length, summary: undone });
}
