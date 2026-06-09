import type { Prisma } from "@prisma/client";
import { completeIdempotentMutation } from "@/app/api/_lib/idempotency";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";

export async function undoSaleBatchInTransaction(
  tx: Prisma.TransactionClient,
  args: {
    businessId: string;
    userId: string;
    routeScope: string;
    sales: Array<{
      id: string;
      totalAmount: Prisma.Decimal | number;
      customer: { name: string } | null;
      saleItems: Array<{ productId: string | null; quantity: number }>;
    }>;
    idempotencyRecordId: string;
  }
) {
  const labels: string[] = [];

  for (const sale of args.sales) {
    const freshSaleItems = await tx.saleItem.findMany({
      where: { saleId: sale.id },
      select: { productId: true, quantity: true },
    });

    for (const item of freshSaleItems) {
      // productId is nullable (product may have been deleted); skip inventory
      // restore for orphaned sale items — there is nothing to restore stock into.
      if (!item.productId) continue;
      await tx.product.update({
        where: { id: item.productId, businessId: args.businessId },
        data: { quantity: { increment: item.quantity } },
      });
    }

    // businessId guard on every delete/deleteMany — defense-in-depth against
    // cross-tenant deletions even though sale.id was pre-filtered by businessId.
    await tx.stockMovement.deleteMany({ where: { referenceId: sale.id, reason: "sale", businessId: args.businessId } });
    await tx.saleItem.deleteMany({ where: { saleId: sale.id } });
    await tx.invoice.deleteMany({ where: { saleId: sale.id } });
    await tx.sale.deleteMany({ where: { id: sale.id, businessId: args.businessId } });

    await tx.cashMovement.deleteMany({
      where: { businessId: args.businessId, saleId: sale.id },
    });

    // Invalidate idempotency records that reference this sale — prevents
    // replay of a deleted sale's response (which contains a now-deleted invoiceId)
    await tx.idempotencyRecord.deleteMany({
      where: {
        businessId: args.businessId,
        actionType: "sale.create",
        responseBody: { contains: sale.id },
      },
    });

    const customerName = sale.customer?.name ?? null;
    const totalAmount = sale.totalAmount;
    labels.push(`${customerName ?? "Consumidor Final"} — $${Number(totalAmount).toFixed(0)}`);

    // Audit row is written INSIDE the same transaction as the side-effects.
    // If any side-effect above throws, the whole tx rolls back — including this
    // audit row — so we never have a partial undo with a dangling audit record.
    // Conversely, if the audit write fails, the transaction rolls back and no
    // undo work is committed, which is the correct invariant.
    await recordCriticalWriteEvent({
      client: tx,
      businessId: args.businessId,
      actorUserId: args.userId,
      routeScope: args.routeScope,
      actionType: "undo.sale",
      resourceType: "sale",
      resourceId: sale.id,
      summary: `Venta deshecha — ${customerName ?? "Consumidor Final"} — $${Number(totalAmount).toFixed(0)}`,
      payload: {
        saleId: sale.id,
        customerName,
        totalAmount,
        saleItemCount: freshSaleItems.length,
      },
    });
  }

  const saleResponseBody = { deleted: args.sales.length, summary: labels };
  await completeIdempotentMutation({
    client: tx,
    recordId: args.idempotencyRecordId,
    responseStatus: 200,
    responseBody: saleResponseBody,
  });

  return { labels };
}
