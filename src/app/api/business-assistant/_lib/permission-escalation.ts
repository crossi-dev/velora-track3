import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";

// Phrases an employee might use when requesting permission to leave / take a break,
// or when explicitly asking for owner authorization on a business action.
//
// IMPORTANT: only match when there is an explicit request marker (the employee is
// ASKING for authorization), NOT when they are merely describing a situation.
//
// YES escalate: "necesito autorización para hacer una devolución"
//               "¿me autorizás un descuento del 20%?"
//               "puedo hacer una devolución?" / "le hago descuento?"
//               "me puedo ir antes?" / "puedo salir?"
// NO escalate:  "el cliente quiere devolver esto"     (describing)
//               "el cliente pide un descuento"         (describing)
//               "le hice un descuento"                 (past, already done)
//               "tengo un reclamo de García"           (reporting)

// Request markers: words that express asking/requesting permission.
const REQUEST_MARKER =
  /\b(necesito|puedo|me pod[eé]s|pod[eé]s|me autoriz[aá]s|autoriz[aá]s|me permit[ií]s|permit[ií]s|tengo que pedir|hay que pedir|pedir permiso|permir|d[eé]jame|me dej[aá]s)\b/i;

// Verbs/nouns that describe actions requiring owner approval when combined with
// a request marker above, OR stand-alone imperative leave/absence phrases.
const PERMISSION_ACTION =
  /\b(devoluci[oó]n|devolver|reclamo|descuento|ajuste.*precio|cambio.*precio|precio.*mal|mal.*precio|sin precio|no tiene precio)\b/i;

// Stand-alone leave/absence phrases (no marker needed — the phrase itself is a request).
const LEAVE_PHRASES =
  /\b(me puedo ir|puedo irme|me voy antes|retir(?:arme|o)|descanso|médico|medico|emergencia|llego tarde|salir antes|faltar|me ausent|turno con|permiso para salir)\b/i;

export function isPermissionRequest(text: string): boolean {
  // Leave/absence are always self-contained requests.
  if (LEAVE_PHRASES.test(text)) return true;
  // Business-action escalation only when there is an explicit request marker.
  return REQUEST_MARKER.test(text) && PERMISSION_ACTION.test(text);
}

// Patterns that look like an owner approving or denying a pending request.
const APPROVAL_PATTERN = /\b(sí|si|dale|autorizo|puede ir|que se vaya|permiso|ok|claro|aceptado)\b/i;
const DENIAL_PATTERN = /\b(no|negado|que se quede|no puede|no autorizo|denegado)\b/i;

const PERM_PREFIX = "perm-req:";
const PERM_WINDOW_MS = 8 * 60 * 60 * 1000; // 8 hours

/** Employee side: write owner_only notification and return early response. */
export async function handlePermissionEscalation({
  text,
  businessId,
  actorEmployeeId,
  respond,
  trace,
}: {
  text: string;
  businessId: string;
  actorEmployeeId: string;
  respond: (body: Record<string, unknown>) => Promise<NextResponse>;
  trace: { add: (step: string, detail: string) => void; toJSON: () => Record<string, unknown> | null };
}): Promise<NextResponse> {
  const employee = await prisma.employee.findUnique({
    where: { id: actorEmployeeId },
    select: { name: true },
  });
  const empName = employee?.name ?? "El empleado";

  const clientMessageId = `${PERM_PREFIX}${actorEmployeeId}:${Date.now()}`;
  const shortRequest = text.slice(0, 160).trim();

  const alertText = `⚠️ ${empName} pide: "${shortRequest}". ¿Lo autorizás?`;
  prisma.chatMessage
    .create({
      data: {
        businessId,
        clientMessageId,
        kind: "reply",
        source: "manager",
        visibility: "owner_only",
        text: alertText,
      },
    })
    .catch((err) =>
      cloudLog({ severity: "ERROR", component: "System", action: "PERM_NOTIFICATION_WRITE_FAILED", a2a_transfer: false, message: "permission escalation notification write failed", businessId, data: { err: err instanceof Error ? err.message : String(err) } }),
    );
  void sendPushToOwner(businessId, { title: "Velora · Pedido de empleado", body: alertText.slice(0, 100), url: "/dashboard", notificationCategory: "anomaly", entityId: actorEmployeeId }).catch(() => {});

  trace.add("permission", `escalated to owner — employee=${actorEmployeeId}`);
  return respond({
    answer: "Le consulté a tu jefe. Te aviso cuando te responda.",
    ...trace.toJSON(),
  });
}

/**
 * Builds the employee-facing reply text for a permission approval/denial.
 * Does NOT concatenate the supAnswer (which is directed at the owner).
 * If supAnswer contains a short reason (≤120 chars, no owner-directed pronouns),
 * it is appended as a quote from the owner.
 */
function buildEmployeeReplyText(approved: boolean, supAnswer: string): string {
  const base = approved
    ? "Tu jefe autorizó. Podés proceder."
    : "Tu jefe no autorizó el pedido.";

  // Append a sanitized quote only when supAnswer is short and doesn't address
  // the owner directly (no "tu empleado", "él", subject pronouns from supervisor→owner flow).
  const ownerDirectedPattern = /\b(tu empleado|el empleado|él|ella|le deci|decile|decíselo)\b/i;
  const trimmed = supAnswer.trim();
  if (trimmed && trimmed.length <= 120 && !ownerDirectedPattern.test(trimmed)) {
    return `${base} Tu jefe dijo: "${trimmed}"`;
  }

  return base;
}

/**
 * Owner side: if the owner's message looks like an approval/denial AND there is a
 * recent pending permission request, write an employee_only reply to that employee.
 * Called AFTER the supervisor has already responded to the owner.
 */
export async function maybeNotifyPermissionApproval({
  text,
  businessId,
  supAnswer,
}: {
  text: string;
  businessId: string;
  supAnswer: string;
}): Promise<{ notified: boolean; employeeId?: string }> {
  const approved = APPROVAL_PATTERN.test(text);
  const denied = DENIAL_PATTERN.test(text);
  if (!approved && !denied) return { notified: false };

  const since = new Date(Date.now() - PERM_WINDOW_MS);
  const pendingAll = await prisma.chatMessage.findMany({
    where: {
      businessId,
      visibility: "owner_only",
      clientMessageId: { startsWith: PERM_PREFIX },
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    select: { clientMessageId: true },
    take: 10,
  });

  if (pendingAll.length === 0) return { notified: false };

  // Deduplicate by empId — one response per employee regardless of how many requests they sent.
  const seenEmpIds = new Set<string>();
  // Build the employee-facing message WITHOUT concatenating supAnswer raw.
  // supAnswer is directed at the owner (second person → dueño); we generate a
  // separate message for the employee instead.
  const replyText = buildEmployeeReplyText(approved, supAnswer);

  let firstEmpId: string | undefined;
  for (const pending of pendingAll) {
    // clientMessageId format: "perm-req:{empId}:{timestamp}"
    const [, empId] = pending.clientMessageId.split(":");
    if (!empId || seenEmpIds.has(empId)) continue;
    seenEmpIds.add(empId);
    if (!firstEmpId) firstEmpId = empId;

    prisma.chatMessage
      .create({
        data: {
          businessId,
          clientMessageId: `perm-resp:${empId}:${Date.now()}`,
          kind: "reply",
          source: "manager",
          visibility: "employee_only",
          targetEmployeeId: empId,
          text: replyText,
        },
      })
      .catch((err) =>
        cloudLog({ severity: "ERROR", component: "System", action: "PERM_REPLY_WRITE_FAILED", a2a_transfer: false, message: "permission escalation employee reply write failed", businessId, data: { empId, err: err instanceof Error ? err.message : String(err) } }),
      );
  }

  return { notified: true, employeeId: firstEmpId };
}
