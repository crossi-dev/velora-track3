import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

const PERM_PREFIX = "perm-req:";
const PERM_WINDOW_MS = 8 * 60 * 60 * 1000; // must match permission-escalation.ts

/**
 * On each employee turn, check whether any of their permission requests have
 * passed the 8-hour response window with no owner reply. For each expired
 * request, write a single employee_only ChatMessage so they know it timed out.
 *
 * Runs before the companion pipeline so the notification appears in the same
 * turn that the employee next opens the chat — no separate cron needed.
 *
 * Dedup: @@unique([businessId, clientMessageId]) on ChatMessage means a second
 * write with the same key is a no-op P2002 — safe to call on every turn.
 * No schema migration required; clientMessageId is the sole source of truth
 * for "has this expiration been notified".
 */
export async function maybeNotifyPermissionExpiration(
  businessId: string,
  employeeId: string,
): Promise<void> {
  const cutoff = new Date(Date.now() - PERM_WINDOW_MS);

  // Fetch expired permission requests for this employee that are older than 8h.
  const expired = await prisma.chatMessage.findMany({
    where: {
      businessId,
      visibility: "owner_only",
      clientMessageId: { startsWith: PERM_PREFIX },
      createdAt: { lt: cutoff },
      // Only requests from this employee (format: "perm-req:{empId}:{ts}").
      // We filter post-query because Prisma doesn't support contains-with-position;
      // the index on (businessId, visibility, createdAt) keeps this cheap.
    },
    select: { id: true, clientMessageId: true },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  if (expired.length === 0) return;

  // Narrow to this employee's requests by parsing the clientMessageId.
  const mine = expired.filter((m) => {
    const parts = m.clientMessageId.split(":");
    // format: "perm-req:{empId}:{timestamp}"
    return parts.length >= 3 && parts[1] === employeeId;
  });

  if (mine.length === 0) return;

  // Fetch owner name once; fallback to "tu jefe" if unavailable.
  let ownerName = "tu jefe";
  try {
    const biz = await prisma.business.findUnique({
      where: { id: businessId },
      select: { user: { select: { name: true } } },
    });
    const name = biz?.user?.name?.trim();
    if (name) ownerName = name;
  } catch {
    // non-fatal — ownerName fallback is fine
  }

  for (const req of mine) {
    const expirationMsgId = `perm-expired:${req.id}`;

    try {
      await prisma.chatMessage.create({
        data: {
          businessId,
          clientMessageId: expirationMsgId,
          kind: "reply",
          source: "manager",
          visibility: "employee_only",
          targetEmployeeId: employeeId,
          text: `El pedido que le hice a ${ownerName} expiró sin respuesta. Si querés podés volver a consultarle.`,
        },
      });
      cloudLog({
        severity: "INFO",
        component: "Employee",
        action: "PERM_EXPIRATION_NOTIFIED",
        a2a_transfer: false,
        message: "permission request expiration notified to employee",
        businessId,
        actorEmployeeId: employeeId,
        data: { originalMsgId: req.clientMessageId },
      });
    } catch (err: unknown) {
      // P2002 = unique constraint — already notified, safe to ignore.
      const code = (err as { code?: string })?.code;
      if (code === "P2002") continue;
      cloudLog({
        severity: "ERROR",
        component: "Employee",
        action: "PERM_EXPIRATION_WRITE_FAILED",
        a2a_transfer: false,
        message: "failed to write permission expiration notification",
        businessId,
        actorEmployeeId: employeeId,
        data: {
          originalMsgId: req.clientMessageId,
          err: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}
