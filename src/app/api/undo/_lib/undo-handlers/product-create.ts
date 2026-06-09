import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { undoProductCreateInTransaction } from "../undo-product-create";
import type { UndoHandlerContext } from "../undo-handler-context";

export async function handleUndoProductCreate(ctx: UndoHandlerContext): Promise<NextResponse> {
  const { businessId, userId, idempotencyRecordId, routeScope, undoCutoff, releaseAndReturnError } = ctx;

  // Find the most recently created product via the audit log
  // (Product has no createdAt column).
  const events = await prisma.criticalWriteEvent.findMany({
    where: {
      businessId,
      actionType: "product.create",
      createdAt: { gte: undoCutoff },
    },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { resourceId: true },
  });

  const candidateId = events[0]?.resourceId;
  if (!candidateId) {
    return releaseAndReturnError({ error: "No hay productos recientes para deshacer." }, 404);
  }

  // Verify ownership and that the product is safe to delete:
  // - must still exist
  // - must belong to this business
  // - must have NO sale items (otherwise sales reference it)
  const product = await prisma.product.findFirst({
    where: { id: candidateId, businessId },
    select: {
      id: true,
      name: true,
      _count: { select: { saleItems: true } },
    },
  });

  if (!product) {
    return releaseAndReturnError({ error: "El producto ya fue eliminado." }, 404);
  }

  if (product._count.saleItems > 0) {
    return releaseAndReturnError(
      { error: `No se puede deshacer: "${product.name}" ya tiene ventas registradas.` },
      409
    );
  }

  // Audit row is written INSIDE the same transaction as the side-effects,
  // matching the undo.sale / undo.cash-movement pattern. If the audit write
  // fails, the tx rolls back and no product is deleted — no partial undo,
  // no orphan audit record.
  await prisma.$transaction(async (tx) => {
    await undoProductCreateInTransaction(tx as unknown as Prisma.TransactionClient, {
      businessId,
      productId: product.id,
      productName: product.name,
      idempotencyRecordId,
    });
    await recordCriticalWriteEvent({
      client: tx,
      businessId,
      actorUserId: userId,
      routeScope,
      actionType: "undo.product-create",
      resourceType: "product",
      resourceId: product.id,
      summary: `Producto deshecho: ${product.name}`,
      payload: { productId: product.id, productName: product.name },
    });
  });

  return NextResponse.json({ deleted: 1, summary: [product.name] });
}
