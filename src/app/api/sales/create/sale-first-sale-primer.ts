// Web Push priming message — inyectado al chat justo después de la PRIMERA
// venta cerrada por chat de un actor (dueño o empleado puntual). Por diseño:
//
//  1. Aparece UNA SOLA VEZ por actor en la vida del negocio:
//     - Owner: gateado por Business.firstSaleConfirmed.
//     - Employee: gateado por Employee.firstSaleConfirmed (mirroring del flag
//       del owner, persistido en la fila del empleado).
//     Persistimos el flag en la misma transacción del primer-write para que
//     ventas siguientes no re-disparen el primer.
//  2. El copy es "value-framed": habla del beneficio antes de pedir la
//     permission. El browser permission prompt en sí lo dispara
//     usePushSubscriptionPrompt en el cliente, gateado por sales.length>0.
//     Este mensaje prepara el momento de valor — primer first, OS dialog second.
//  3. visibility="owner_only" (owner) / "employee_only" + targetEmployeeId
//     (employee) — cada actor sólo ve el suyo.
//  4. Idempotencia: condicionamos el UPDATE al flag=false. Si dos ventas
//     concurrentes carrerean al mismo tiempo, sólo una pasa y la otra ve
//     count=0 y skipea. clientMessageId también dedupea a nivel de chat row.
//
// Errores siempre se loguean y se tragan — el primer es UX, no money path.

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { enqueueOnboardingNudge, ONBOARDING_NUDGE_QUEUE } from "@/lib/cloud-tasks-onboarding-nudge";
import { INITIAL_DELAY_SECONDS } from "@/app/api/_lib/onboarding-nudge-windows";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";

const OWNER_PRIMER_TEXT =
  "¿Te aviso cuando entren ventas, queden pocos productos o tu empleada necesite algo? " +
  "Tocá *Sí, avisame* cuando te aparezca el cartel del navegador para activar los avisos.";

const EMPLOYEE_PRIMER_TEXT =
  "¿Te aviso cuando el dueño te asigne tareas o cuando necesite que mires algo? " +
  "Tocá *Sí, avisame* cuando te aparezca el cartel del navegador para activar los avisos.";

export interface FirstSalePrimerResult {
  /** True si esta llamada fue la que disparó el primer (write-once). */
  primed: boolean;
  /** Razón por la cual no se primeó (si primed=false). */
  skippedReason: "already_primed" | "no_business_user" | "write_failed" | null;
}

/**
 * Inyecta el mensaje de priming Web Push una sola vez para el OWNER.
 *
 * Returns primed=true SI Y SOLO SI esta invocación fue la que cambió el flag
 * Business.firstSaleConfirmed de false a true (compare-and-set vía updateMany count).
 */
export async function maybeWriteOwnerFirstSalePrimer(args: {
  businessId: string;
  saleId: string;
}): Promise<FirstSalePrimerResult> {
  const { businessId, saleId } = args;

  let updated: { count: number };
  try {
    updated = await prisma.business.updateMany({
      where: { id: businessId, firstSaleConfirmed: false },
      data: { firstSaleConfirmed: true },
    });
  } catch (error) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "OWNER_PUSH_PRIMER_FLAG_FAILED",
      a2a_transfer: false,
      message: "first-sale primer flag flip failed",
      businessId,
      data: { saleId, error: error instanceof Error ? error.message : String(error) },
    });
    return { primed: false, skippedReason: "write_failed" };
  }

  if (updated.count === 0) {
    return { primed: false, skippedReason: "already_primed" };
  }

  const clientMessageId = `owner-push-primer-${businessId}`;
  return writePrimerChatRow({
    businessId,
    clientMessageId,
    text: OWNER_PRIMER_TEXT,
    visibility: "owner_only",
    targetEmployeeId: null,
    logScope: { saleId, action: "OWNER" },
  });
}

/**
 * Inyecta el mensaje de priming Web Push una sola vez para un EMPLOYEE.
 *
 * Returns primed=true SI Y SOLO SI esta invocación fue la que cambió el flag
 * Employee.firstSaleConfirmed de false a true. El mensaje queda dirigido al
 * empleado (visibility=employee_only + targetEmployeeId).
 */
export async function maybeWriteEmployeeFirstSalePrimer(args: {
  businessId: string;
  employeeId: string;
  saleId: string;
}): Promise<FirstSalePrimerResult> {
  const { businessId, employeeId, saleId } = args;

  let updated: { count: number };
  try {
    updated = await prisma.employee.updateMany({
      where: { id: employeeId, businessId, firstSaleConfirmed: false },
      data: { firstSaleConfirmed: true },
    });
  } catch (error) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "EMPLOYEE_PUSH_PRIMER_FLAG_FAILED",
      a2a_transfer: false,
      message: "employee first-sale primer flag flip failed",
      businessId,
      data: { saleId, employeeId, error: error instanceof Error ? error.message : String(error) },
    });
    return { primed: false, skippedReason: "write_failed" };
  }

  if (updated.count === 0) {
    return { primed: false, skippedReason: "already_primed" };
  }

  const clientMessageId = `employee-push-primer-${employeeId}`;
  return writePrimerChatRow({
    businessId,
    clientMessageId,
    text: EMPLOYEE_PRIMER_TEXT,
    visibility: "employee_only",
    targetEmployeeId: employeeId,
    logScope: { saleId, action: "EMPLOYEE", employeeId },
  });
}

async function writePrimerChatRow(args: {
  businessId: string;
  clientMessageId: string;
  text: string;
  visibility: "owner_only" | "employee_only";
  targetEmployeeId: string | null;
  logScope: { saleId: string; action: "OWNER" | "EMPLOYEE"; employeeId?: string };
}): Promise<FirstSalePrimerResult> {
  const { businessId, clientMessageId, text, visibility, targetEmployeeId, logScope } = args;
  try {
    await prisma.chatMessage.create({
      data: {
        businessId,
        clientMessageId,
        kind: "reply",
        source: "manager",
        visibility,
        text,
        ...(targetEmployeeId ? { targetEmployeeId } : {}),
      },
    });
    cloudLog({
      severity: "INFO",
      component: "System",
      action: `${logScope.action}_PUSH_PRIMER_INJECTED`,
      a2a_transfer: false,
      message: "first-sale primer chat message injected",
      businessId,
      data: { saleId: logScope.saleId, employeeId: logScope.employeeId },
    });
    return { primed: true, skippedReason: null };
  } catch (error) {
    const code = (error as { code?: string } | null)?.code;
    if (code === "P2002") {
      // Chat row ya existía (deploy retry, doble-click, etc). El flag ya
      // está en true, así que para el caller fue exitoso "moralmente".
      return { primed: true, skippedReason: null };
    }
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: `${logScope.action}_PUSH_PRIMER_WRITE_FAILED`,
      a2a_transfer: false,
      message: "first-sale primer chat write failed (flag already flipped)",
      businessId,
      data: {
        saleId: logScope.saleId,
        employeeId: logScope.employeeId,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return { primed: false, skippedReason: "write_failed" };
  }
}

// Back-compat alias — keep the older name resolvable for any external caller.
export type OwnerFirstSalePrimerResult = FirstSalePrimerResult;

/**
 * Stamps Business.firstSaleAt = now() on the first sale, then enqueues the
 * first onboarding-nudge Cloud Task (attempt=0, 24h delay).
 *
 * Uses updateMany WHERE firstSaleAt IS NULL so concurrent sales race safely:
 * only one wins (count=1), the rest see count=0 and no-op.
 * Only the winner enqueues the task — dedup enforced by the compare-and-set.
 *
 * firstSaleAt is the idle-window anchor for integration nudges (design §14.4).
 * Cloud Tasks chain replaces the old hourly cron (velora-onboarding-integration-nudge).
 * Queue: ONBOARDING_NUDGE_QUEUE (default "velora-onboarding-nudge").
 * Pattern: mirrors the fire-and-forget sale-post-commit pattern.
 *
 * Never throws — best-effort, logged on failure.
 */
export async function maybeStampFirstSaleAt(args: {
  businessId: string;
  saleId: string;
}): Promise<void> {
  // Feature flag gate — matches how maybeSendIntegrationNudge reads the flag.
  // firstSaleAt is the anchor for proactive integration nudges (design §14.4);
  // stamping it while the feature is off would prime the nudge idle-window
  // clock without any nudge logic running — a flag-contract violation.
  if (process.env.PROACTIVE_ONBOARDING_ENABLED !== "true") return;

  const { businessId, saleId } = args;
  let stamped = false;
  try {
    const result = await prisma.business.updateMany({
      where: { id: businessId, firstSaleAt: null },
      data: { firstSaleAt: new Date() },
    });
    stamped = result.count > 0;
  } catch (error) {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "FIRST_SALE_AT_STAMP_FAILED",
      a2a_transfer: false,
      message: "firstSaleAt stamp failed (non-blocking)",
      businessId,
      data: { saleId, error: error instanceof Error ? error.message : String(error) },
    });
    return;
  }

  if (!stamped) return; // not the first sale — another concurrent sale already stamped

  // Gate released: enqueue the first nudge task (attempt=0) with the MP idle
  // window delay (24h). Fire-and-forget — must NOT block or throw into the sale path.
  // enqueueOnboardingNudge never throws (errors are absorbed and logged inside).
  // Dedup: named task prevents double-enqueue if two concurrent first-sale races
  // both reach this line (only one wins the updateMany above, so this is belt-and-suspenders).
  //
  // Queue: ONBOARDING_NUDGE_QUEUE — must be created in Cloud Tasks before enabling
  // PROACTIVE_ONBOARDING_ENABLED=true.
  // Ref: https://cloud.google.com/tasks/docs/creating-http-target-tasks
  const slotDate = getArgentinaDateString(Date.now());
  void enqueueOnboardingNudge({
    businessId,
    attempt: 0,
    delaySeconds: INITIAL_DELAY_SECONDS, // 24h = MP window
    slotDate,
  });

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "FIRST_SALE_NUDGE_TASK_QUEUED",
    a2a_transfer: false,
    message: `First-sale gate released — onboarding nudge chain started (queue=${ONBOARDING_NUDGE_QUEUE}, delay=24h)`,
    businessId,
    data: { saleId, attempt: 0, delaySeconds: INITIAL_DELAY_SECONDS, slotDate },
  });
}
