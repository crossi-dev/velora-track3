import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { undoCustomerBatchInTransaction } from "../undo-customer";
import type { UndoHandlerContext } from "../undo-handler-context";

export async function handleUndoCustomer(ctx: UndoHandlerContext): Promise<NextResponse> {
  const { businessId, userId, safeCount, idempotencyRecordId, routeScope, undoCutoff, releaseAndReturnError } = ctx;

  const customers = await prisma.customer.findMany({
    where: { businessId, createdAt: { gte: undoCutoff } },
    orderBy: { createdAt: "desc" },
    take: safeCount,
    select: { id: true, name: true, _count: { select: { sales: true } } },
  });

  if (customers.length === 0) {
    return releaseAndReturnError({ error: "No hay clientes para eliminar." }, 404);
  }

  const withSales = customers.filter((customer) => customer._count.sales > 0);
  if (withSales.length > 0) {
    const names = withSales.map((customer) => customer.name).join(", ");
    return releaseAndReturnError({ error: `No se pueden eliminar clientes con ventas registradas: ${names}.` }, 409);
  }

  const ids = customers.map((customer) => customer.id);
  // Audit row is written INSIDE the same transaction as the side-effects,
  // matching the undo.sale / undo.cash-movement pattern. If the audit write
  // fails, the tx rolls back and no deletion is committed — no partial undo,
  // no orphan audit record.
  await prisma.$transaction(async (tx) => {
    await undoCustomerBatchInTransaction(tx as unknown as Prisma.TransactionClient, {
      businessId,
      customerIds: ids,
      customers,
      idempotencyRecordId,
    });
    await recordCriticalWriteEvent({
      client: tx,
      businessId,
      actorUserId: userId,
      routeScope,
      actionType: "undo.customer",
      resourceType: "customer",
      resourceId: ids.join(","),
      summary: `${customers.length} cliente${customers.length === 1 ? "" : "s"} eliminado${customers.length === 1 ? "" : "s"}`,
      payload: {
        customerIds: ids,
        customerNames: customers.map((customer) => customer.name),
        deletedCount: customers.length,
      },
    });
  });

  return NextResponse.json({
    deleted: customers.length,
    summary: customers.map((customer) => customer.name),
  });
}
