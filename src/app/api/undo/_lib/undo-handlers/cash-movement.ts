import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { undoCashMovementBatchInTransaction } from "../undo-cash-movement";
import type { UndoHandlerContext } from "../undo-handler-context";

export async function handleUndoCashMovement(ctx: UndoHandlerContext): Promise<NextResponse> {
  const { businessId, userId, safeCount, idempotencyRecordId, routeScope, undoCutoff, releaseAndReturnError } = ctx;

  // Find recent MANUAL cash movements (saleId === null) within the cutoff.
  // Sale-linked movements must only be reversed via target=sale to keep
  // the sale and its cash entries in sync.
  const movements = await prisma.cashMovement.findMany({
    where: {
      businessId,
      saleId: null,
      createdAt: { gte: undoCutoff },
    },
    orderBy: { createdAt: "desc" },
    take: safeCount,
    select: { id: true, description: true, amount: true },
  });

  if (movements.length === 0) {
    return releaseAndReturnError({ error: "No hay movimientos de caja para deshacer." }, 404);
  }

  const ids = movements.map((m) => m.id);
  const movementsForUndo = movements.map((m) => ({
    id: m.id,
    description: m.description,
    amount: Number(m.amount),
  }));

  // Audit row is written INSIDE the same transaction as the side-effects,
  // matching the undo.sale pattern. If the audit write fails the tx rolls back
  // and no cash mutation is committed — no partial undo, no orphan audit.
  await prisma.$transaction(async (tx) => {
    await undoCashMovementBatchInTransaction(tx as unknown as Prisma.TransactionClient, {
      businessId,
      movementIds: ids,
      movements: movementsForUndo,
      idempotencyRecordId,
    });
    await recordCriticalWriteEvent({
      client: tx,
      businessId,
      actorUserId: userId,
      routeScope,
      actionType: "undo.cash-movement",
      resourceType: "cash-movement",
      resourceId: ids.join(","),
      summary: `${movements.length} movimiento${movements.length === 1 ? "" : "s"} de caja deshecho${movements.length === 1 ? "" : "s"}`,
      payload: {
        movementIds: ids,
        descriptions: movements.map((m) => m.description),
        deletedCount: movements.length,
      },
    });
  });

  return NextResponse.json({
    deleted: movements.length,
    summary: movements.map((m) => m.description),
  });
}
