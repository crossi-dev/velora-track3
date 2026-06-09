import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";
import { recordPostCommitFailure } from "@/app/api/_lib/post-commit-failure-tracker";
import type { InvoicePayload } from "@/infrastructure/shared/invoice-document";
import { buildSaleConfirmationText } from "./sale-confirmation-text";

// Mensaje único por venta al chat del dueño + push paralelo. Resume "qué se
// vendió y a quién" en una línea, y notifica al dueño en su dispositivo.
//
// Privacy: visibility="owner_only" — el empleado no lo ve.
//
// Dedup: clientMessageId = `sale-confirmation-${saleId}`. P2002 → ya escrito
// antes y ya se envió el push en aquel intento, salimos silenciosos.
//
// Push: best-effort, sólo se intenta si la fila de chat se creó nueva.
// Errores de fan-out se loguean pero no se propagan.
//
// Pure formatter en sale-confirmation-text.ts (testeable sin prisma/env).

export async function writeSaleConfirmationToOwner(args: {
  businessId: string;
  saleId: string;
  invoicePayload: InvoicePayload;
  actorEmployeeId: string | null;
}): Promise<void> {
  const { businessId, saleId, invoicePayload, actorEmployeeId } = args;
  const text = buildSaleConfirmationText({
    items: invoicePayload.sale.items,
    customerName: invoicePayload.customer.name,
    total: invoicePayload.sale.total,
    currency: invoicePayload.business.currency,
  });
  const clientMessageId = `sale-confirmation-${saleId}`;

  try {
    await prisma.chatMessage.create({
      data: {
        businessId,
        clientMessageId,
        kind: "reply",
        source: "manager",
        visibility: "owner_only",
        text,
      },
    });
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "P2002") return;
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "SALE_CONFIRMATION_WRITE_FAILED",
      a2a_transfer: false,
      message: "sale-confirmation chat message write failed",
      businessId,
      data: { saleId, error: error instanceof Error ? error.message : String(error) },
    });
    return;
  }

  // B3: owner is the actor → don't send a notification to themselves.
  if (!actorEmployeeId) return;

  try {
    const fan = await sendPushToOwner(businessId, {
      title: "Velora · Venta registrada",
      body: text.slice(0, 120),
      url: "/dashboard",
      notificationCategory: "sale_confirmation",
      entityId: saleId,
    });
    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SALE_CONFIRMATION_NOTIFIED",
      a2a_transfer: false,
      message: "sale-confirmation chat written + push fanned out",
      businessId,
      data: { saleId, pushAttempted: fan.attempted, pushSent: fan.sent, pushExpired: fan.expired },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "SALE_CONFIRMATION_PUSH_FAILED",
      a2a_transfer: false,
      message: "sale-confirmation push fanout failed",
      businessId,
      data: { saleId, error: errorMessage },
    });
    void recordPostCommitFailure({ businessId, saleId, action: "SALE_CONFIRMATION_PUSH_FAILED", errorMessage });
  }
}
