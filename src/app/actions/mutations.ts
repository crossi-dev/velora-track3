"use server";

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { recordCriticalWriteEvent } from "@/infrastructure/shared/critical-write-audit";
import { invalidateBusinessContext } from "@/app/api/business-assistant/_lib/context";
import { cloudLog } from "@/lib/cloud-logger";

type InvoiceStatus = "issued" | "sent" | "paid";

export type UpdateInvoiceStatusResult =
  | { ok: true; invoiceId: string; status: InvoiceStatus }
  | { ok: false; error: string };

// ── updateInvoiceStatusAction ────────────────────────────────────────────────

export async function updateInvoiceStatusAction(
  invoiceId: string,
  status: InvoiceStatus,
): Promise<UpdateInvoiceStatusResult> {
  const session = await auth();
  if (!session?.user?.id) return { ok: false, error: "Authentication required." };

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, status: true, businessId: true, invoiceNumber: true, business: { select: { userId: true } } },
  });
  if (!invoice || invoice.business.userId !== session.user.id) {
    return { ok: false, error: "Invoice not found." };
  }

  const current = invoice.status as InvoiceStatus;
  if (current === "paid" && (status === "issued" || status === "sent")) {
    return { ok: false, error: "Cannot change status of a paid invoice." };
  }
  if (current === "sent" && status === "issued") {
    return { ok: false, error: "Cannot revert a sent invoice to issued." };
  }

  try {
    // Defense-in-depth tenant guard: updateMany scoped by id+businessId closes
    // the race window between the ownership read above and this write.
    const { count } = await prisma.invoice.updateMany({ where: { id: invoiceId, businessId: invoice.businessId }, data: { status } });
    if (count === 0) return { ok: false, error: "Invoice not found." };

    await recordCriticalWriteEvent({
      client: prisma, businessId: invoice.businessId, actorUserId: session.user.id,
      routeScope: "invoices/update-status", actionType: "invoice.update-status",
      resourceType: "Invoice", resourceId: invoiceId,
      summary: `Factura ${invoice.invoiceNumber} → ${status}`,
      payload: { invoiceId, status },
    });

    invalidateBusinessContext(invoice.businessId);
    return { ok: true, invoiceId, status };
  } catch (e) {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "invoice.update-status",
      a2a_transfer: false,
      message: "updateInvoiceStatusAction failed",
      businessId: invoice.businessId,
      data: {
        invoiceId,
        status,
        error: e instanceof Error ? e.message : String(e),
      },
    });
    return { ok: false, error: "Could not update the invoice status." };
  }
}
