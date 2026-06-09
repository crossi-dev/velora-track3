import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { undoSaleBatchInTransaction } from "../undo-sale";
import type { UndoHandlerContext } from "../undo-handler-context";
import { sendCustomerRefundNotification } from "@/app/api/agents/communications/jsonrpc/_lib/handle-communications-rpc";

export async function handleUndoSale(ctx: UndoHandlerContext): Promise<NextResponse> {
  const { businessId, userId, safeCount, idempotencyRecordId, routeScope, undoCutoff, releaseAndReturnError } = ctx;

  const [sales, business] = await Promise.all([
    prisma.sale.findMany({
      where: { businessId, date: { gte: undoCutoff } },
      orderBy: { date: "desc" },
      take: safeCount,
      select: {
        id: true,
        date: true,
        totalAmount: true,
        customer: { select: { name: true, phone: true } },
        saleItems: {
          select: { productId: true, quantity: true },
        },
      },
    }),
    prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true },
    }),
  ]);

  if (sales.length === 0) {
    return releaseAndReturnError({ error: "No hay ventas recientes para deshacer (máximo 24 horas)." }, 404);
  }

  const saleIds = sales.map((s) => s.id);

  // TOCTOU fix: re-check invoice state INSIDE the transaction so that an
  // invoice that transitions to "sent"/"paid" between the pre-check and
  // the undo cannot slip through. We throw a typed error and unwrap it
  // outside the tx to keep the happy path clean.
  const INVOICE_LOCKED = "INVOICE_LOCKED:";
  let result: Awaited<ReturnType<typeof undoSaleBatchInTransaction>>;
  try {
    result = await prisma.$transaction(async (tx) => {
      const protectedInvoices = await tx.invoice.findMany({
        where: { saleId: { in: saleIds }, status: { in: ["sent", "paid"] } },
        select: { saleId: true, invoiceNumber: true, status: true },
      });
      if (protectedInvoices.length > 0) {
        const nums = protectedInvoices.map((i) => i.invoiceNumber).join(", ");
        const verb = protectedInvoices[0].status === "paid" ? "cobrada" : "enviada";
        throw new Error(`${INVOICE_LOCKED}${verb}|${nums}`);
      }

      // Audit rows are written INSIDE this transaction alongside side-effects.
      // On any inner throw the whole tx rolls back — no partial undo, no orphan audit.
      return undoSaleBatchInTransaction(tx as unknown as Prisma.TransactionClient, {
        businessId,
        userId,
        routeScope,
        sales,
        idempotencyRecordId,
      });
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(INVOICE_LOCKED)) {
      const [, rest] = err.message.split(INVOICE_LOCKED);
      const [verb, nums] = (rest ?? "|").split("|");
      return releaseAndReturnError(
        { error: `No se puede deshacer: la factura ${nums} ya fue ${verb}.` },
        400
      );
    }
    throw err;
  }

  // Customer WPP notification — best-effort, fire-and-forget after commit.
  // Atomic claim on undoNotificationSentAt prevents double-fire on retry.
  void (async () => {
    const businessName = business?.name ?? "";
    for (const sale of sales) {
      const phone = sale.customer?.phone ?? null;
      if (!phone) continue; // skip silently — no phone on record

      // Atomic claim per sale.
      const claimed = await prisma.sale.updateMany({
        where: { id: sale.id, businessId, undoNotificationSentAt: null },
        data: { undoNotificationSentAt: new Date() },
      });
      if (claimed.count === 0) continue; // already sent by concurrent runner

      await sendCustomerRefundNotification({
        businessId,
        customerPhone: phone,
        customerName: sale.customer?.name ?? null,
        businessName,
        amount: Number(sale.totalAmount),
        reason: "undo_sale",
        referenceId: sale.id,
      });
    }
  })();

  return NextResponse.json({ deleted: sales.length, summary: result.labels });
}
