// Aviso al DUEÑO cuando se acredita un pago de link de pago.
//
// El cliente paga el link y NO tiene que avisar nada: apenas el webhook de
// Mercado Pago confirma el pago, el dueño recibe el aviso solo — un
// ChatMessage owner_only ("💰 Pago recibido…") + una push notification.
//
// Best-effort: nunca tira (un fallo acá no debe bloquear comprobante/envío).
// Idempotente por clientMessageId — un webhook re-entregado no avisa dos veces.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";

const CURRENCY_FMT = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
});

/**
 * Notifica al dueño que se acreditó un pago. Invocado por el post-confirm
 * del camino link de pago. Mejor esfuerzo — captura todo error y solo logea.
 */
export async function notifyOwnerOnPayment(
  paymentIntentId: string,
  businessId: string,
): Promise<void> {
  try {
    // findFirst with compound where — OWASP secure-by-default tenant isolation.
    // businessId is required (H2 fix: removes optional-param footgun).
    const intent = await prisma.paymentIntent.findFirst({
      where: { id: paymentIntentId, businessId },
      select: { id: true, businessId: true, monto: true, matchedCustomerId: true },
    });
    if (!intent) return;

    let customerName: string | null = null;
    // findFirst with businessId: defense-in-depth tenant guard on customer PII.
    if (intent.matchedCustomerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: intent.matchedCustomerId, businessId: intent.businessId },
        select: { name: true },
      });
      customerName = customer?.name ?? null;
    }

    const montoFmt = CURRENCY_FMT.format(Number(intent.monto));
    const who = customerName ? ` de ${customerName}` : "";

    // Idempotency: a re-delivered webhook must not write a second nudge.
    // clientMessageId is unique — a duplicate create throws P2002.
    const clientMessageId = `pago-recibido-${intent.id}`;
    try {
      await prisma.chatMessage.create({
        data: {
          businessId: intent.businessId,
          clientMessageId,
          kind: "reply",
          source: "manager",
          visibility: "owner_only",
          text: `💰 Pago recibido — ${montoFmt}${who}. Te genero el comprobante y agendo el envío.`,
        },
      });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "P2002") return; // already notified — skip the push too
      throw err;
    }

    // K #4: Push failure is observable — WARNING log includes paymentIntentId
    // so Cloud Logging can surface delivery failures. Still fire-and-forget:
    // push failure must not block the chat nudge already written.
    void sendPushToOwner(intent.businessId, {
      title: "Velora · Pago recibido",
      body: `Cobraste ${montoFmt}${who}.`,
      url: "/dashboard",
      notificationCategory: "sale_confirmation",
      entityId: intent.id,
    }).catch((pushErr) => {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "OWNER_PUSH_FAILED",
        a2a_transfer: false,
        message: `sendPushToOwner failed: ${pushErr instanceof Error ? pushErr.message : String(pushErr)}`,
        businessId: intent.businessId,
        data: { paymentIntentId: intent.id },
      });
    });

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "OWNER_PAYMENT_NOTIFIED",
      a2a_transfer: false,
      message: "Owner notified of confirmed payment",
      businessId: intent.businessId,
      data: { paymentIntentId: intent.id },
    });
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "OWNER_PAYMENT_NOTIFY_FAILED",
      a2a_transfer: false,
      message: `notifyOwnerOnPayment failed: ${err instanceof Error ? err.message : String(err)}`,
      data: { paymentIntentId },
    });
  }
}
