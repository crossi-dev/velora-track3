// Employee chat onboarding — first-time welcome + guided task sequence.
// Renderers (subtype × task → instruction string) live in employee-onboarding.renderers.ts.
// Free-order: employee completes the 6 tasks in any order they prefer.

import {
  celebrationFor,
  detectBusinessSubtype,
  SUBTYPE_TASK_RENDERERS,
} from "./employee-onboarding.renderers";
// Detection: audit events (sale.create, stock-load.create)
// + DB timestamp columns (onboardingStockQueryDoneAt, onboardingSalesQueryDoneAt,
//   onboardingCobroQrDoneAt, onboardingSaleSendDoneAt).
// When all tasks done → onboardingCompletedAt persisted, module short-circuits.

export type OnboardingTask =
  | "first_sale"
  | "first_stock_query"
  | "first_cobro_qr"
  | "first_sale_send"
  | "first_stock_load"
  | "first_sales_query";

// Cronological order: learn to sell → check stock → collect via QR → send receipt
// → load inventory → review the day.
export const ONBOARDING_TASKS: ReadonlyArray<OnboardingTask> = [
  "first_sale",
  "first_stock_query",
  "first_cobro_qr",
  "first_sale_send",
  "first_stock_load",
  "first_sales_query",
];

interface AuditEvent {
  actionType: string;
  // Otros campos del audit log no se usan para esta lógica.
}

/** Subset of the Employee DB record used for onboarding detection. */
export interface EmployeeOnboardingFields {
  onboardingStockQueryDoneAt: Date | null;
  onboardingSalesQueryDoneAt: Date | null;
  onboardingCobroQrDoneAt: Date | null;
  onboardingSaleSendDoneAt: Date | null;
  onboardingCompletedAt: Date | null;
}

/**
 * Dado el historial de eventos del empleado + los campos DB del empleado,
 * determina cuál es la próxima tarea de onboarding pendiente.
 *
 * Detection strategy per task:
 *   - first_sale:        audit event sale.create
 *   - first_stock_query: employee.onboardingStockQueryDoneAt (persisted to DB)
 *   - first_cobro_qr:    employee.onboardingCobroQrDoneAt (persisted to DB)
 *   - first_sale_send:   employee.onboardingSaleSendDoneAt (persisted to DB)
 *   - first_stock_load:  audit event stock-load.create
 *   - first_sales_query: employee.onboardingSalesQueryDoneAt (persisted to DB)
 *
 * Free-order: el orden del array `ONBOARDING_TASKS` se usa solo como
 * default-suggestion. El empleado puede completarlas en cualquier orden.
 *
 * Note: _userMessages param kept for backward-compat but is no longer used
 * for detection — query tasks are now persisted to DB.
 */
export function nextOnboardingTask(
  events: AuditEvent[],
  _userMessages: string[] = [],
  employeeFields?: EmployeeOnboardingFields | null,
): OnboardingTask | null {
  const completed = computeCompleted(events, employeeFields);
  for (const task of ONBOARDING_TASKS) {
    if (!completed.has(task)) return task;
  }
  return null;
}

/**
 * Lista TODAS las tareas pendientes — usado por el welcome para mostrar
 * las pendientes al empleado y dejar claro que puede arrancar por la que quiera.
 */
export function pendingOnboardingTasks(
  events: AuditEvent[],
  _userMessages: string[] = [],
  employeeFields?: EmployeeOnboardingFields | null,
): OnboardingTask[] {
  const completed = computeCompleted(events, employeeFields);
  return ONBOARDING_TASKS.filter((task) => !completed.has(task));
}

function computeCompleted(
  events: AuditEvent[],
  employeeFields?: EmployeeOnboardingFields | null,
): Set<OnboardingTask> {
  const completed = new Set<OnboardingTask>();
  for (const event of events) {
    if (event.actionType === "sale.create") completed.add("first_sale");
    if (event.actionType === "stock-load.create") completed.add("first_stock_load");
  }
  // Tasks persisted in DB columns (no audit event generated).
  if (employeeFields?.onboardingStockQueryDoneAt) completed.add("first_stock_query");
  if (employeeFields?.onboardingSalesQueryDoneAt) completed.add("first_sales_query");
  if (employeeFields?.onboardingCobroQrDoneAt) completed.add("first_cobro_qr");
  if (employeeFields?.onboardingSaleSendDoneAt) completed.add("first_sale_send");
  return completed;
}

interface BusinessSummary {
  name: string;
  type?: string;
  topProductNames: string[];
  topProductSample?: { name: string; price: number; currency: string };
  activeRules?: string[];
  /** If provided, only these tasks are listed in the welcome (avoids listing done tasks). */
  pendingTasks?: OnboardingTask[];
}

/**
 * Mensaje de bienvenida — primera vez del empleado.
 * Intencionalmente corto: saludo + UNA instrucción concreta.
 * Las 6 tareas de onboarding se guardan para cuando el empleado pida
 * "ver tareas" o "qué tengo que hacer" (no se vuelcan en el welcome).
 *
 * Tono: compañero de turno, no checklist corporativo.
 */
export function buildWelcomeMessage(args: {
  employeeName: string;
  business: BusinessSummary;
  task: OnboardingTask;
}): string {
  const { employeeName, business, task } = args;

  const firstName = employeeName.split(" ")[0];
  const greeting = `¡Hola ${firstName}! Soy Velora, te acompaño en tu turno.`;
  const firstInstruction = buildFirstInstruction(task, business);

  return `${greeting}\n\n${firstInstruction}`;
}

/**
 * Genera la primera instrucción concreta basada en la tarea pendiente.
 * Máximo 2 oraciones — el empleado necesita acción, no tutorial.
 */
function buildFirstInstruction(task: OnboardingTask, business: BusinessSummary): string {
  const sample = business.topProductSample;
  const product = (sample?.name ?? business.topProductNames[0] ?? "un producto").toLowerCase();

  switch (task) {
    case "first_sale":
      return `Para empezar, contame tu primera venta: ¿qué vendiste, a quién y cuánto?`;
    case "first_stock_query":
      return `Podés consultarme el stock cuando quieras. Probá: "¿cuánto tenemos de ${product}?"`;
    case "first_cobro_qr":
      return `Cuando quieras cobrar por QR, avisame y te armo el link de pago.`;
    case "first_sale_send":
      return `Para mandar el comprobante al cliente por WhatsApp, avisame al registrar la venta.`;
    case "first_stock_load":
      return `Si llegó mercadería, contame: "llegaron [cantidad] [producto]" y lo anoto.`;
    case "first_sales_query":
      return `Cuando quieras ver el resumen del día, preguntame: "¿cómo anduvo la caja hoy?"`;
  }
}

/**
 * Mensaje de transición — entre una tarea completada y la siguiente.
 * Más corto que el welcome, mantiene momentum.
 *
 * Proactividad: después de la celebración confirmamos que el empleado
 * está listo para seguir antes de tirarle la próxima instrucción. Si
 * la tarea recién completada es first_sale, sumamos el primer de
 * notificaciones (el client-side hook usePushSubscriptionPrompt detecta
 * el ≥1 sale y dispara el browser permission prompt; este copy
 * prepara el momento de valor).
 */
/**
 * Generic transition message used when we can't identify which task was just
 * completed. Avoids wrong-task celebration (e.g., saying "primera venta"
 * when the employee actually queried stock).
 */
export function buildGenericTransitionMessage(nextTask: OnboardingTask | null, business: BusinessSummary): string {
  if (!nextTask) {
    return "Listo. Ya sabés operar este negocio. ¡A laburar!";
  }
  return `Listo, una menos. ${taskInstruction(nextTask, business)}`;
}

export function buildTransitionMessage(args: {
  completedTask: OnboardingTask;
  nextTask: OnboardingTask | null;
  business: BusinessSummary;
}): string {
  const { completedTask, nextTask, business } = args;

  const congrats = celebrationFor(completedTask);
  const notifPrimer = completedTask === "first_sale"
    ? `\n\nTe puede saltar un aviso del navegador para activar notificaciones — aceptalo si querés que te avisemos cuando el dueño te mande algo.`
    : "";

  if (!nextTask) {
    return `${congrats}${notifPrimer}\n\nYa sabés todo lo que necesitás. Cualquier duda, preguntame. ¡A laburar!`;
  }

  return `${congrats}${notifPrimer}\n\n${taskInstruction(nextTask, business)}`;
}

function taskInstruction(task: OnboardingTask, business: BusinessSummary): string {
  const sample = business.topProductSample;
  const exampleProduct = sample?.name ?? business.topProductNames[0] ?? "un producto";
  const examplePrice = sample?.price ?? 1000;
  const subtype = detectBusinessSubtype(business.type);
  return SUBTYPE_TASK_RENDERERS[subtype][task]({
    exampleProduct: exampleProduct.toLowerCase(),
    examplePrice,
  });
}
