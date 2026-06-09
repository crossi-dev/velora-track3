// Promesa-vencida cron logic — extracted for testability (route.ts stays thin).
//
// Query pattern: PaymentIntent where metodo="promesa" AND estado="confirmed"
// AND promesaExpectedAt < now() AND the idempotent ChatMessage for today
// does NOT yet exist (P2002 acts as the already-notified guard, same pattern
// as notifyOwnerOnPayment).
//
// Idempotency key: "promesa-vencida-{paymentIntentId}-{YYYYMMDD_ART}"
//   — re-runs on the same calendar day are no-ops (P2002 on chatMessage unique).
//   — the slot resets at ART midnight so a lingering un-settled promesa
//     does NOT re-fire every day (only once per day, one notice per tenant-day).
//
// No schema migration: the ChatMessage unique constraint is the "notified" marker.
// Adding promesaVencidaNotifiedAt to PaymentIntent would need a migration and
// would permanently mark PIs — the ChatMessage approach is cheaper and matches
// the existing notifyOwnerOnPayment convention.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";
import { getArgentinaDateString } from "@/lib/argentina-date";

/**
 * Returns "YYYYMMDD" idempotency slot for Argentina time.
 * Uses Intl-based getArgentinaDateString — no manual offset math.
 * Source: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/DateTimeFormat
 */
function artDateSlot(nowMs: number): string {
  return getArgentinaDateString(nowMs).replace(/-/g, "");
}

/** Returns "DD/MM/YYYY" display label for Argentina time. */
function artDateLabel(date: Date): string {
  const [yyyy, mm, dd] = getArgentinaDateString(date.getTime()).split("-");
  return `${dd}/${mm}/${yyyy}`;
}

export interface PromesaVencidaResult {
  found: number;
  notified: number;
  alreadyNotified: number;
  errors: number;
}

interface OverdueIntent {
  id: string;
  businessId: string;
  monto: number | { toNumber: () => number } | string;
  promesaExpectedAt: Date;
  matchedCustomerId: string | null;
}

async function notifyOne(
  intent: OverdueIntent,
  dateSlot: string,
  result: PromesaVencidaResult,
): Promise<void> {
  try {
    let customerName: string | null = null;
    // findFirst with businessId: defense-in-depth tenant guard on customer PII.
    if (intent.matchedCustomerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: intent.matchedCustomerId, businessId: intent.businessId },
        select: { name: true },
      });
      customerName = customer?.name ?? null;
    }

    const expectedLabel = artDateLabel(intent.promesaExpectedAt);
    const clientMessageId = `promesa-vencida-${intent.id}-${dateSlot}`;

    // Attempt to write the owner-only nudge. P2002 = already notified today.
    try {
      const who = customerName ?? "un cliente";
      const body = `⏰ La promesa de pago de ${who} venció el ${expectedLabel}. ¿Cobraste? Si sí, marcá settle. Si no, hacé el follow-up.`;

      await prisma.chatMessage.create({
        data: {
          businessId: intent.businessId,
          clientMessageId,
          kind: "reply",
          source: "manager",
          visibility: "owner_only",
          text: body,
        },
      });

      // Best-effort push — void to not block the loop.
      void sendPushToOwner(intent.businessId, {
        title: "Velora · Promesa vencida",
        body: `La promesa de ${who} venció el ${expectedLabel}.`,
        url: "/dashboard",
        notificationCategory: "sale_confirmation",
        entityId: intent.id,
      }).catch(() => {
        // Push failure never blocks the chat nudge already written.
      });

      cloudLog({
        severity: "INFO",
        component: "Payments",
        action: "PROMESA_VENCIDA_NOTIFIED",
        a2a_transfer: false,
        message: "Owner notified of overdue promesa",
        businessId: intent.businessId,
        data: { paymentIntentId: intent.id, expectedAt: intent.promesaExpectedAt, customer: who },
      });

      result.notified += 1;
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === "P2002") {
        result.alreadyNotified += 1;
        return;
      }
      throw err;
    }
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "Payments",
      action: "PROMESA_VENCIDA_NOTIFY_FAILED",
      a2a_transfer: false,
      message: `promesa-vencida notification failed for PI ${intent.id}: ${err instanceof Error ? err.message : String(err)}`,
      businessId: intent.businessId,
      data: { paymentIntentId: intent.id },
    });
    result.errors += 1;
  }
}

export async function runPromesaVencidaCron(
  nowMs: number = Date.now(),
): Promise<PromesaVencidaResult> {
  const result: PromesaVencidaResult = {
    found: 0,
    notified: 0,
    alreadyNotified: 0,
    errors: 0,
  };

  const now = new Date(nowMs);
  const dateSlot = artDateSlot(nowMs);

  // Fetch all confirmed promesas whose expected date is in the past.
  // "confirmed" = the owner registered the promise but cash hasn't arrived yet.
  // No upper bound: lingering overdue promesas keep firing once per day until settled.
  const overdueIntents = await prisma.paymentIntent.findMany({
    where: {
      metodo: "promesa",
      estado: "confirmed",
      promesaExpectedAt: { lt: now },
    },
    select: {
      id: true,
      businessId: true,
      monto: true,
      promesaExpectedAt: true,
      matchedCustomerId: true,
    },
    // Safety cap — at MVP scale promesas are low-volume. Cap prevents
    // an outlier tenant from consuming the whole cron window.
    take: 200,
    orderBy: { promesaExpectedAt: "asc" },
  });

  result.found = overdueIntents.length;

  if (overdueIntents.length === 0) {
    cloudLog({
      severity: "INFO",
      component: "Payments",
      action: "PROMESA_VENCIDA_NONE",
      a2a_transfer: false,
      message: "promesa-vencida cron: no overdue promesas found",
    });
    return result;
  }

  cloudLog({
    severity: "INFO",
    component: "Payments",
    action: "PROMESA_VENCIDA_START",
    a2a_transfer: false,
    message: `promesa-vencida cron: found ${overdueIntents.length} overdue promesas`,
    data: { dateSlot },
  });

  // Sequential loop — promesas are low-volume; parallel fan-out is unnecessary.
  for (const intent of overdueIntents) {
    await notifyOne(intent as OverdueIntent, dateSlot, result);
  }

  return result;
}
