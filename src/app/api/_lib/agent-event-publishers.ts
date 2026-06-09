// High-level publishers — wrappers fire-and-forget que arman el evento
// y lo escriben al log/supervisor. Los call sites en handlers usan
// estos wrappers para mantenerse compactos. Nunca tiran: si la publish
// falla, log y siguen.

import { randomUUID } from "crypto";
import type { LowStockEvent, StockIngressRequestEvent } from "@/lib/agent-contract";
import { EMPLOYEE_EVENT_PROTOCOL } from "@/lib/agent-contract";
import { reportEventPayloadSchema } from "@/lib/event-schemas";
import type { StockIngressDecision } from "@/lib/a2a-transport";
import {
  buildLowStockEvent,
  buildChatMessageEvent,
  buildCompanionResponseEvent,
  buildSupervisorQueryEvent,
  buildStockIngressRequestEvent,
} from "./agent-event-builders";
import { publishEmployeeEvent, publishAuditOnlyEvent } from "./agent-events";
import { cloudLog, reportError } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { executeStockIngress } from "./stock-ingress-executor";

/**
 * Fire-and-forget publish del evento LOW_STOCK al supervisor. Pensado
 * para ser llamado con `void publishLowStockFromSale(...)` en el response
 * path — nunca tira ni bloquea. Errores van a console.error con businessId
 * + saleId para correlación.
 */
export async function publishLowStockFromSale(args: {
  businessId: string;
  actorEmployeeId: string | null;
  saleId: string;
  alerts: LowStockEvent["alerts"];
}): Promise<void> {
  try {
    const event = buildLowStockEvent(args);
    const result = await publishEmployeeEvent(event);
    if (result.status === "error") {
      // publishEmployeeEvent never throws — it returns status:"error" when the
      // transport fails. Log here so LOW_STOCK failures surface clearly.
      cloudLog({ severity: "ERROR", component: "System", action: "LOW_STOCK_PUBLISH_FAILED", a2a_transfer: false, message: "A2A LOW_STOCK publish failed (transport error)", businessId: args.businessId, data: { saleId: args.saleId, reason: result.reason } });
    }
  } catch (error) {
    cloudLog({ severity: "ERROR", component: "System", action: "LOW_STOCK_PUBLISH_FAILED", a2a_transfer: false, message: "A2A LOW_STOCK publish failed (exception)", businessId: args.businessId, data: { saleId: args.saleId, error: error instanceof Error ? error.message : String(error) } });
    reportError(error, { scope: "agent-event-publishers.low-stock", businessId: args.businessId, saleId: args.saleId });
  }
}

/**
 * Fire-and-forget: emite CHAT_MESSAGE al log y retorna eventId para
 * que el caller pueda encadenar COMPANION_RESPONSE.inReplyToEventId.
 * Si el publish falla, retorna null pero no tira.
 */
export async function publishChatMessage(args: {
  businessId: string;
  actorEmployeeId: string | null;
  text: string;
  locale: string | null;
  actorRole: "owner" | "employee";
  clientMessageId: string | null;
}): Promise<string | null> {
  try {
    const event = buildChatMessageEvent(args);
    const result = await publishAuditOnlyEvent(event);
    return result.status === "sent" || result.status === "skipped" ? event.eventId : null;
  } catch (error) {
    cloudLog({ severity: "WARNING", component: "System", action: "CHAT_MESSAGE_PUBLISH_FAILED", a2a_transfer: false, message: "CHAT_MESSAGE publish failed", businessId: args.businessId, data: { error: error instanceof Error ? error.message : String(error) } });
    return null;
  }
}

/** Fire-and-forget. NO tira si falla. */
export async function publishCompanionResponse(args: {
  businessId: string;
  actorEmployeeId: string | null;
  inReplyToEventId: string;
  intent: string;
  safeIntent: string;
  answer: string;
  confidence: number | null;
  requiresClarification: boolean;
  actionsEmitted: string[];
}): Promise<void> {
  try {
    const event = buildCompanionResponseEvent(args);
    await publishAuditOnlyEvent(event);
  } catch (error) {
    cloudLog({ severity: "WARNING", component: "System", action: "COMPANION_RESPONSE_PUBLISH_FAILED", a2a_transfer: false, message: "COMPANION_RESPONSE publish failed", businessId: args.businessId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

/**
 * Publica un STOCK_INGRESS_REQUEST al Supervisor y espera la decisión (sync).
 * Si aprobado, ejecuta el ingreso en la DB. Siempre retorna la decisión.
 */
export async function publishStockIngressRequest(args: {
  businessId: string;
  actorEmployeeId: string | null;
  items: StockIngressRequestEvent["items"];
  supplierName: string | null;
}): Promise<StockIngressDecision> {
  const policy = await prisma.delegationPolicy.findFirst({
    where: { businessId: args.businessId, scope: "stock", active: true },
    select: { maxValue: true, requiresOwner: true },
  });
  const maxIngressTicket = policy?.requiresOwner ? 0 : (policy?.maxValue ? Number(policy.maxValue) : 0);

  const event = buildStockIngressRequestEvent({ ...args, maxIngressTicket });
  const result = await publishEmployeeEvent(event);
  const decision = result.stockIngressDecision ?? { approved: false, anomaly: false, reason: "sin política de aprobación activa" };

  if (decision.approved && !decision.anomaly) {
    try {
      await executeStockIngress(args.items, args.businessId, args.actorEmployeeId);
    } catch (err) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "STOCK_INGRESS_EXECUTE_FAILED",
        a2a_transfer: false,
        message: "executeStockIngress failed after supervisor approval",
        businessId: args.businessId,
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      // Execution failed — reflect the failure in the returned decision so the
      // caller does not believe the ingress was applied when it wasn't.
      return { ...decision, approved: false, reason: err instanceof Error ? err.message : "stock ingress execution failed" };
    }
  }

  return decision;
}

/** Fire-and-forget. NO tira si falla. */
export async function publishSupervisorQuery(args: {
  businessId: string;
  actorEmployeeId: string | null;
  inReplyToEventId: string;
  escalationKind: "B1_clarification_loop" | "B2_long_input" | "owner_direct" | "companion_answer_escalation";
  supervisorAnswer: string;
}): Promise<void> {
  try {
    const event = buildSupervisorQueryEvent(args);
    await publishAuditOnlyEvent(event);
  } catch (error) {
    cloudLog({ severity: "WARNING", component: "System", action: "SUPERVISOR_QUERY_PUBLISH_FAILED", a2a_transfer: false, message: "SUPERVISOR_QUERY publish failed", businessId: args.businessId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}

/** Fire-and-forget. Persiste un REPORT_EVENT del empleado al AgentEventLog.
 *  Aparece en la tab Bus A2A del dueño. Nunca tira. */
export async function publishReportEvent(args: {
  businessId: string;
  actorEmployeeId: string | null;
  eventType: string | null;
  details: string | null;
  productName: string | null;
}): Promise<void> {
  const parsed = reportEventPayloadSchema.safeParse({
    eventType: args.eventType,
    details: args.details,
    productName: args.productName,
  });
  if (!parsed.success) {
    cloudLog({ severity: "WARNING", component: "System", action: "REPORT_EVENT_INVALID_PAYLOAD", a2a_transfer: false, message: "REPORT_EVENT payload failed Zod validation — dropped", businessId: args.businessId, data: { issues: parsed.error.issues } });
    return;
  }
  try {
    await prisma.agentEventLog.create({
      data: {
        businessId: args.businessId,
        eventId: randomUUID(),
        protocol: EMPLOYEE_EVENT_PROTOCOL.name,
        protocolVersion: EMPLOYEE_EVENT_PROTOCOL.version,
        eventType: "REPORT_EVENT",
        actorEmployeeId: args.actorEmployeeId,
        source: "employee_agent",
        destination: "owner_feed",
        payloadJson: JSON.stringify(parsed.data),
        status: "delivered",
        processedAt: new Date(),
      },
    });
  } catch (error) {
    cloudLog({ severity: "WARNING", component: "System", action: "REPORT_EVENT_PUBLISH_FAILED", a2a_transfer: false, message: "REPORT_EVENT publish failed", businessId: args.businessId, data: { error: error instanceof Error ? error.message : String(error) } });
  }
}
