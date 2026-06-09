// Server-side wrapper para la lógica pura de employee-onboarding.
//
// Glue entre el state del DB (Employee, Business, audit log) y la pure
// logic de src/lib/employee-onboarding.ts.
//
// Se invoca desde /api/business-assistant POST cuando el actor es un
// empleado en onboarding. Si todavía hay tareas pendientes, retorna un
// mensaje de welcome/transition que se PRE-pendea al answer del modelo.
// Cuando el empleado termina las 4 tareas, retorna null y el chat
// vuelve al modo normal.

import { prisma } from "@/lib/prisma";
import {
  buildGenericTransitionMessage,
  buildTransitionMessage,
  buildWelcomeMessage,
  nextOnboardingTask,
  pendingOnboardingTasks,
  type OnboardingTask,
} from "@/lib/employee-onboarding";

interface BuildOptions {
  employeeId: string;
  businessId: string;
}

interface OnboardingResponse {
  /**
   * Mensaje a prepender al answer del modelo. Empty string si no aplica.
   * El caller hace `${response.message}\n\n${modelAnswer}` para la respuesta final.
   */
  message: string;
  /** Tarea actual del empleado. null = onboarding completo. */
  currentTask: OnboardingTask | null;
}

const EMPTY_RESPONSE: OnboardingResponse = {
  message: "",
  currentTask: null,
};

const TASK_FIELD_MAP = {
  stock_query: {
    data: { onboardingStockQueryDoneAt: new Date() },
    where: { onboardingStockQueryDoneAt: null },
  },
  sales_query: {
    data: { onboardingSalesQueryDoneAt: new Date() },
    where: { onboardingSalesQueryDoneAt: null },
  },
  cobro_qr: {
    data: { onboardingCobroQrDoneAt: new Date() },
    where: { onboardingCobroQrDoneAt: null },
  },
  sale_send: {
    data: { onboardingSaleSendDoneAt: new Date() },
    where: { onboardingSaleSendDoneAt: null },
  },
} as const;

/**
 * Marks an onboarding task as done by persisting a timestamp to DB.
 * Idempotent: uses updateMany with a null-check so already-set rows are skipped.
 */
export async function markOnboardingTaskDone(
  employeeId: string,
  task: keyof typeof TASK_FIELD_MAP,
): Promise<void> {
  const mapping = TASK_FIELD_MAP[task];
  await prisma.employee
    .updateMany({
      where: { id: employeeId, ...mapping.where },
      data: mapping.data,
    })
    .catch(() => {
      // Swallow — idempotent, already set is fine.
    });
}

/**
 * Determina si el empleado está en onboarding y, si sí, qué mensaje
 * incluir en la respuesta del chat.
 *
 * Short-circuit: if employee.onboardingCompletedAt is set, returns
 * EMPTY_RESPONSE immediately — no audit query, no task computation.
 */
export async function buildEmployeeOnboardingResponse(
  args: BuildOptions,
): Promise<OnboardingResponse> {
  const { employeeId, businessId } = args;

  // Load employee with onboarding fields for short-circuit + detection.
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: {
      name: true,
      onboardingStockQueryDoneAt: true,
      onboardingSalesQueryDoneAt: true,
      onboardingCobroQrDoneAt: true,
      onboardingSaleSendDoneAt: true,
      onboardingCompletedAt: true,
    },
  });

  if (!employee) return EMPTY_RESPONSE;

  // Fast-path: all tasks done in a previous session — skip everything.
  if (employee.onboardingCompletedAt) return EMPTY_RESPONSE;

  // Eventos de audit del empleado — qué tareas ya completó.
  // take:50 es holgado para el onboarding (4 tareas) y previene scans grandes
  // en un empleado con historial extenso. El detector solo necesita los primeros
  // eventos de cada actionType, así que "asc" + cap es correcto.
  const events = await prisma.criticalWriteEvent.findMany({
    where: { businessId, actorEmployeeId: employeeId },
    select: { actionType: true },
    orderBy: { createdAt: "asc" },
    take: 50,
  });

  const currentTask = nextOnboardingTask(events, [], employee);
  if (!currentTask) {
    // All tasks just completed — persist the completion timestamp.
    await prisma.employee
      .updateMany({
        where: { id: employeeId, onboardingCompletedAt: null },
        data: { onboardingCompletedAt: new Date() },
      })
      .catch(() => {});
    return EMPTY_RESPONSE;
  }

  // Cargamos negocio + top productos + reglas activas para personalizar el mensaje.
  const [business, topProducts, activeRules] = await Promise.all([
    prisma.business.findUnique({
      where: { id: businessId },
      select: { name: true, type: true, currency: true },
    }),
    prisma.product.findMany({
      where: { businessId },
      select: { name: true, price: true },
      orderBy: { name: "asc" },
      take: 5,
    }),
    prisma.businessRule.findMany({
      where: { businessId, active: true },
      select: { message: true },
      take: 3,
    }),
  ]);

  if (!business) return EMPTY_RESPONSE;

  const topProductNames = topProducts.map((p) => p.name);
  const topProductSample = topProducts[0]
    ? {
        name: topProducts[0].name,
        price: Number(topProducts[0].price),
        currency: business.currency,
      }
    : undefined;

  // Distinguir welcome (primer mensaje, sin actividad previa) vs transition.
  // "Primer mensaje" = no hay events y ninguna query-task marcada en DB.
  const hasActivity =
    events.length > 0 ||
    employee.onboardingStockQueryDoneAt !== null ||
    employee.onboardingSalesQueryDoneAt !== null ||
    employee.onboardingCobroQrDoneAt !== null ||
    employee.onboardingSaleSendDoneAt !== null;

  if (!hasActivity) {
    const pending = pendingOnboardingTasks(events, [], employee);
    const taskForWelcome = pending[0] ?? currentTask;
    const message = buildWelcomeMessage({
      employeeName: employee.name,
      business: {
        name: business.name,
        type: business.type,
        topProductNames,
        topProductSample,
        activeRules: activeRules.map((r) => r.message),
        pendingTasks: pending,
      },
      task: taskForWelcome,
    });
    return { message, currentTask };
  }

  // Hay actividad previa — armar la transición.
  const completedTask = inferLastCompleted({ events, employee, currentTask });
  const businessSummary = { name: business.name, topProductNames, topProductSample };

  // Use generic message when we can't determine which task was completed —
  // avoids wrong-task celebration (e.g., saying "primera venta" when the
  // employee actually queried stock).
  const transitionMessage = completedTask
    ? buildTransitionMessage({ completedTask, nextTask: currentTask, business: businessSummary })
    : buildGenericTransitionMessage(currentTask, businessSummary);

  return {
    message: transitionMessage,
    currentTask,
  };
}

function inferTaskFromAudit(actionType: string): OnboardingTask | null {
  if (actionType === "sale.create") return "first_sale";
  if (actionType === "stock-load.create") return "first_stock_load";
  return null;
}

/** Returns the last completed task, or null if it can't be determined. */
function inferLastCompleted(args: {
  events: { actionType: string }[];
  employee: {
    onboardingStockQueryDoneAt: Date | null;
    onboardingSalesQueryDoneAt: Date | null;
    onboardingCobroQrDoneAt: Date | null;
    onboardingSaleSendDoneAt: Date | null;
  };
  currentTask: OnboardingTask;
}): OnboardingTask | null {
  const { events, employee, currentTask } = args;
  // Find the most recently set DB timestamp — it's the freshest signal.
  const candidates: [number, OnboardingTask][] = [
    [employee.onboardingStockQueryDoneAt?.getTime() ?? 0, "first_stock_query"],
    [employee.onboardingSalesQueryDoneAt?.getTime() ?? 0, "first_sales_query"],
    [employee.onboardingCobroQrDoneAt?.getTime() ?? 0, "first_cobro_qr"],
    [employee.onboardingSaleSendDoneAt?.getTime() ?? 0, "first_sale_send"],
  ];
  const latestDb = candidates.reduce<[number, OnboardingTask] | null>((best, c) => {
    if (c[0] === 0) return best;
    if (!best || c[0] > best[0]) return c;
    return best;
  }, null);
  if (latestDb && latestDb[1] !== currentTask) return latestDb[1];
  // Fall back to audit events.
  const lastEvent = events[events.length - 1];
  const fromAudit = lastEvent ? inferTaskFromAudit(lastEvent.actionType) : null;
  if (fromAudit && fromAudit !== currentTask) return fromAudit;
  // Can't determine — return null so caller uses generic message.
  return null;
}
