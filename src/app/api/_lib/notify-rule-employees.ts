// Notifica a todos los empleados activos del negocio sobre cambios en una
// regla (creación, update o reactivación). Genera dos efectos:
//   1. ChatMessage con source:"manager" para que aparezca en el chat del empleado.
//   2. Push notification al device del empleado (best-effort, fail-soft).
//
// Compartido entre supervisor (rule-actions) y owner form (POST/PATCH).
// El companion NO emite estos mensajes — son del sistema notificando al
// empleado, no del LLM hablando.

import { prisma } from "@/lib/prisma";
import { sendPushToEmployee } from "./employee-push";
import { cloudLog } from "@/lib/cloud-logger";

export async function notifyRuleEmployees(
  businessId: string,
  ruleId: string,
  body: string,
): Promise<void> {
  const employees = await prisma.employee.findMany({
    where: { businessId, active: true },
    select: { id: true },
  });
  // Include a timestamp slot (minute-precision) so each rule update event gets a
  // distinct clientMessageId. Without this, the second update to the same rule
  // silently deduplicates against the first and the employee never sees it.
  const slot = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  await Promise.all(
    employees.map(async (emp) => {
      await prisma.chatMessage.create({
        data: {
          businessId,
          clientMessageId: `rule-notify-${ruleId}-${emp.id}-${slot}`,
          kind: "reply",
          source: "manager",
          visibility: "employee_only",
          targetEmployeeId: emp.id,
          text: body,
        },
      }).catch((err: unknown) => {
        const code = (err as { code?: string } | null)?.code;
        if (code !== "P2002") {
          cloudLog({ severity: "WARNING", component: "System", action: "RULE_NOTIFY_CHAT_FAILED", a2a_transfer: false, message: "ChatMessage create failed for rule notification", businessId, data: { ruleId, employeeId: emp.id, error: err instanceof Error ? err.message : String(err) } });
        }
      });
      await sendPushToEmployee(businessId, emp.id, {
        title: "Velora · Regla actualizada",
        body,
        url: "/dashboard",
        notificationCategory: "rule_alert",
        entityId: `${ruleId}:${emp.id}`,
      }).catch(() => {});
    }),
  );
}
