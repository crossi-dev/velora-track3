// When sendPush detects a 401/403/404/410 from the push service and marks the
// subscription expired, this helper injects a one-per-day ChatMessage with
// source="manager" so the user is prompted to re-subscribe.
//
// Idempotency key: push-resub-{businessId}-{userId}-{YYYY-MM-DD}
// P2002 (duplicate) is silently swallowed — once per day is enough.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

const RESUB_TEXT =
  "Las notificaciones se desactivaron. Tocá acá para reactivarlas.";

const RESUB_CHIPS = {
  kind: "action",
  options: [{ label: "Reactivar", value: "reactivar_notificaciones", action: "subscribe_push" }],
};

function todaySlot(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
}

/**
 * Best-effort: never throws. Caller continues regardless of outcome.
 *
 * @param businessId  business the subscription belongs to
 * @param userId      the value stored in PushSubscription.userId
 *                    (owner → OAuth user id; employee → Employee.id)
 * @param visibility  "owner_only" for owner subscriptions, "employee_only"
 *                    for employee subscriptions
 * @param targetEmployeeId  Employee.id to set targetEmployeeId for targeted
 *                    employee messages (pass null for owner)
 */
export async function injectPushResubPrompt(
  businessId: string,
  userId: string,
  visibility: "owner_only" | "employee_only",
  targetEmployeeId: string | null,
): Promise<void> {
  const clientMessageId = `push-resub-${businessId}-${userId}-${todaySlot()}`;
  try {
    await prisma.chatMessage.create({
      data: {
        businessId,
        clientMessageId,
        kind: "reply",
        source: "manager",
        visibility,
        targetEmployeeId: targetEmployeeId ?? undefined,
        text: RESUB_TEXT,
        chips: RESUB_CHIPS,
      },
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "P2002") return; // already injected today — silent dedup
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "PUSH_RESUB_PROMPT_FAILED",
      a2a_transfer: false,
      message: "Failed to inject push re-subscribe prompt",
      businessId,
      data: { userId, visibility, code, error: err instanceof Error ? err.message.slice(0, 200) : String(err) },
    });
  }
}
