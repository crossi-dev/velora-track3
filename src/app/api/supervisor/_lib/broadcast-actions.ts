import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { sendPushToEmployee } from "@/app/api/_lib/employee-push";
import { getServerActionMeta } from "@/app/api/_lib/mutation-contract";
import {
  deriveSupervisorIdempotencyKey as deriveIdempotencyKey,
  withSupervisorContractGuards as withContractGuards,
  isDemoLimitReached,
} from "./contract-helpers";
import type { SupervisorAction } from "./business-rule-actions";

const BROADCAST_SEND_ACTION = getServerActionMeta("broadcast.send");

export interface BroadcastResult {
  confirmation: string | null;
  error: string | null;
  notified: number;
}

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

export async function executeBroadcastActions(
  actions: ReadonlyArray<SupervisorAction>,
  businessId: string,
  actorUserId: string,
  idempotencySeed: string,
): Promise<BroadcastResult> {
  const broadcastActions = actions.filter((a) => a.intent === "broadcast_employees");
  if (broadcastActions.length === 0) return { confirmation: null, error: null, notified: 0 };

  const employees = await prisma.employee.findMany({
    where: { businessId, active: true },
    select: { id: true, name: true },
  });

  if (employees.length === 0) {
    return { confirmation: "No hay empleados activos para notificar.", error: null, notified: 0 };
  }

  let notified = 0;
  let idx = 0;
  for (const action of broadcastActions) {
    const data = asObject(action.data);
    const message = typeof data?.message === "string" && data.message.trim()
      ? data.message.trim()
      : action.summary ?? "Mensaje del dueño.";

    // El seed varía por turno; el índice distingue varios broadcasts en el mismo turno.
    const idempotencyKey = deriveIdempotencyKey(`${idempotencySeed}|${idx}`, "broadcast_employees", { message });
    const guarded = await withContractGuards({
      actionType: BROADCAST_SEND_ACTION.actionType,
      routeScope: BROADCAST_SEND_ACTION.routeScope,
      resourceType: BROADCAST_SEND_ACTION.resourceType,
      businessId,
      actorUserId,
      idempotencyKey,
      requestBody: { message, employeeCount: employees.length },
      summaryFor: (res: { delivered: number }) => ({
        summary: `Broadcast a ${res.delivered} empleado(s)`,
        resourceId: null,
        payload: { message, delivered: res.delivered, employeeIds: employees.map((e) => e.id) },
      }),
      exec: async () => {
        let delivered = 0;
        await Promise.all(
          employees.map(async (emp) => {
            const clientMessageId = `broadcast-${businessId}-${emp.id}-${idempotencyKey.slice(0, 12)}`;
            await prisma.chatMessage.create({
              data: {
                businessId,
                targetEmployeeId: emp.id,
                clientMessageId,
                kind: "reply",
                source: "manager",
                visibility: "employee_only",
                text: message,
              },
            }).catch((chatErr: unknown) => {
              const errMsg = chatErr instanceof Error ? chatErr.message : String(chatErr);
              const isUniqueViolation = errMsg.includes("Unique constraint");
              if (!isUniqueViolation) {
                cloudLog({
                  severity: "WARNING",
                  component: "Supervisor",
                  action: "BROADCAST_CHAT_PERSIST_FAILED",
                  a2a_transfer: false,
                  message: "Broadcast chat message persist failed",
                  businessId,
                  data: { error: errMsg, isUniqueViolation },
                });
              }
            });
            await sendPushToEmployee(businessId, emp.id, {
              title: "Velora · Mensaje del dueño",
              body: message,
              url: "/dashboard",
              notificationCategory: "rule_alert",
              entityId: `broadcast:${idempotencyKey.slice(0, 12)}:${emp.id}`,
            }).catch(() => {});
            delivered++;
          }),
        );
        return { delivered };
      },
    });
    idx += 1;
    if (!("skipped" in guarded) && !isDemoLimitReached(guarded)) {
      notified += guarded.value.delivered;
    }
  }

  return {
    confirmation: `Aviso enviado a ${notified} empleado${notified !== 1 ? "s" : ""}.`,
    error: null,
    notified,
  };
}
