import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { undoSupplierBatchInTransaction } from "../undo-supplier";
import type { UndoHandlerContext } from "../undo-handler-context";

export async function handleUndoSupplier(ctx: UndoHandlerContext): Promise<NextResponse> {
  const { businessId, userId, safeCount, idempotencyRecordId, routeScope, undoCutoff, releaseAndReturnError } = ctx;

  // Find the most recently created supplier(s) via the audit log,
  // since Supplier has no createdAt column.
  const events = await prisma.criticalWriteEvent.findMany({
    where: {
      businessId,
      actionType: "supplier.create",
      createdAt: { gte: undoCutoff },
    },
    orderBy: { createdAt: "desc" },
    take: safeCount,
    select: { resourceId: true, createdAt: true },
  });

  const candidateIds = events.map((e) => e.resourceId).filter((id): id is string => !!id);
  if (candidateIds.length === 0) {
    return releaseAndReturnError({ error: "No hay proveedores recientes para deshacer." }, 404);
  }

  // Verify the suppliers still exist and belong to this business.
  const suppliers = await prisma.supplier.findMany({
    where: { id: { in: candidateIds }, businessId },
    select: { id: true, name: true },
  });

  if (suppliers.length === 0) {
    return releaseAndReturnError({ error: "El proveedor ya fue eliminado." }, 404);
  }

  const ids = suppliers.map((s) => s.id);
  // Audit row is written INSIDE the same transaction as the side-effects,
  // matching the undo.sale / undo.cash-movement pattern. If the audit write
  // fails, the tx rolls back and no supplier is deleted — no partial undo,
  // no orphan audit record.
  await prisma.$transaction(async (tx) => {
    await undoSupplierBatchInTransaction(tx as unknown as Prisma.TransactionClient, {
      businessId,
      supplierIds: ids,
      suppliers,
      idempotencyRecordId,
    });
    await recordCriticalWriteEvent({
      client: tx,
      businessId,
      actorUserId: userId,
      routeScope,
      actionType: "undo.supplier",
      resourceType: "supplier",
      resourceId: ids.join(","),
      summary: `${suppliers.length} proveedor${suppliers.length === 1 ? "" : "es"} eliminado${suppliers.length === 1 ? "" : "s"}`,
      payload: {
        supplierIds: ids,
        supplierNames: suppliers.map((s) => s.name),
        deletedCount: suppliers.length,
      },
    });
  });

  return NextResponse.json({
    deleted: suppliers.length,
    summary: suppliers.map((s) => s.name),
  });
}
