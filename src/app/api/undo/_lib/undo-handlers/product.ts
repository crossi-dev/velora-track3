import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { cloudLog } from "@/lib/cloud-logger";
import { undoProductRestoreInTransaction, parseRestoredProductData } from "../undo-product";
import type { UndoHandlerContext } from "../undo-handler-context";

export async function handleUndoProduct(ctx: UndoHandlerContext): Promise<NextResponse> {
  const {
    businessId,
    userId,
    productId,
    idempotencyRecordId,
    routeScope,
    undoCutoff,
    releaseAndReturnError,
  } = ctx;

  if (!productId || typeof productId !== "string") {
    return releaseAndReturnError({ error: "Falta el identificador del producto." }, 400);
  }

  const existing = await prisma.product.findFirst({
    where: { id: productId, businessId },
    select: { id: true },
  });
  if (existing) {
    return releaseAndReturnError({ error: "El producto ya existe." }, 409);
  }

  const traceRow = await prisma.criticalWriteEvent.findFirst({
    where: {
      businessId,
      actionType: "product.delete",
      resourceId: productId,
    },
    orderBy: { createdAt: "desc" },
    select: { payloadJson: true, createdAt: true },
  });

  if (!traceRow?.payloadJson) {
    return releaseAndReturnError({ error: "No se encontró información del producto eliminado." }, 404);
  }

  if (traceRow.createdAt < undoCutoff) {
    return releaseAndReturnError({ error: "No se puede restaurar un producto eliminado hace más de 24 horas." }, 400);
  }

  // Soft warning window: between 23h and 24h since deletion the restore
  // still succeeds, but we flag it so the UI can confirm intent.
  const elapsedMs = Date.now() - traceRow.createdAt.getTime();
  const nearCutoffWarning =
    elapsedMs >= 23 * 60 * 60 * 1000 && elapsedMs < 24 * 60 * 60 * 1000
      ? "El producto fue eliminado hace casi 24 horas. Confirmá que todavía querés restaurarlo."
      : null;

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(traceRow.payloadJson);
  } catch (err) {
    cloudLog({ severity: "ERROR", component: "System", action: "UNDO_PRODUCT_CORRUPTED_PAYLOAD", a2a_transfer: false, message: "Corrupted JSON in product delete trace payload", data: { rowId: productId, actionType: "product.delete", error: err instanceof Error ? err.message : String(err) } });
    return releaseAndReturnError(
      { error: "No se pudo leer la información del producto eliminado." },
      500
    );
  }

  const productData = parseRestoredProductData(rawPayload);
  if (!productData) {
    return releaseAndReturnError({ error: "No se pudo leer la información del producto eliminado." }, 500);
  }

  const restoredStock = productData.stock ?? 0;

  // Audit row is written INSIDE the same transaction as the side-effects,
  // matching the undo.sale / undo.cash-movement pattern. If the audit write
  // fails, the tx rolls back and no product is restored — no partial undo,
  // no orphan audit record.
  await prisma.$transaction(async (tx) => {
    await undoProductRestoreInTransaction(tx as unknown as Prisma.TransactionClient, {
      businessId,
      productId,
      productData,
      idempotencyRecordId,
    });
    await recordCriticalWriteEvent({
      client: tx,
      businessId,
      actorUserId: userId,
      routeScope,
      actionType: "undo.product",
      resourceType: "product",
      resourceId: productId,
      summary: `Producto restaurado: ${productData.name}`,
      payload: {
        productId,
        productName: productData.name,
        restoredStock,
      },
    });
  });

  const response: Record<string, unknown> = { restored: 1, productId, name: productData.name };
  if (nearCutoffWarning) {
    response.warning = nearCutoffWarning;
  }
  return NextResponse.json(response);
}
