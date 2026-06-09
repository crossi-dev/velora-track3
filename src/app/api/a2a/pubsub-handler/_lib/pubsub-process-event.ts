import { NextResponse } from "next/server";
import { formatEventTextSummary, EMPLOYEE_EVENT_PROTOCOL, type EmployeeEvent } from "@/lib/agent-contract";
import { runSupervisor } from "@/app/api/supervisor/_lib/supervisor-runner";
import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";
import { writeSupervisorAlertChat } from "@/app/api/_lib/supervisor-chat-write";
import { prisma } from "@/lib/prisma";
import { logA2ATransfer, cloudLog } from "@/lib/cloud-logger";
import { classifyError } from "./classify-error";

export { classifyError };

// Ventana de claim para idempotencia concurrente. Debe superar maxDuration
// del supervisor (40s) con margen para evitar que dos handlers concurrentes
// llamen al supervisor y dupliquen el push al dueño.
const CLAIM_WINDOW_MS = 60_000;

function buildSynthText(event: EmployeeEvent): string {
  return [
    "EMPLOYEE_EVENT",
    `protocol: ${event.protocol}`,
    `protocolVersion: ${EMPLOYEE_EVENT_PROTOCOL.version}`,
    `type: ${event.type}`,
    `businessId: ${event.businessId}`,
    `eventId: ${event.eventId}`,
    "---",
    formatEventTextSummary(event),
  ].join("\n");
}

export async function processEvent(event: EmployeeEvent): Promise<NextResponse> {
  try {
    const upserted = await prisma.agentEventLog.upsert({
      where: { businessId_eventId: { businessId: event.businessId, eventId: event.eventId } },
      create: {
        businessId: event.businessId,
        eventId: event.eventId,
        protocol: event.protocol,
        protocolVersion: event.protocolVersion,
        eventType: event.type,
        actorEmployeeId: event.actorEmployeeId,
        source: "employee_agent",
        destination: "supervisor",
        payloadJson: JSON.stringify(event),
        status: "pending",
      },
      update: {},
      select: { status: true },
    });
    if (upserted.status === "delivered") return new NextResponse(null, { status: 204 });

    // Atomic claim — only the first concurrent handler proceeds.
    const claimed = await prisma.agentEventLog.updateMany({
      where: {
        businessId: event.businessId,
        eventId: event.eventId,
        OR: [{ processedAt: null }, { processedAt: { lt: new Date(Date.now() - CLAIM_WINDOW_MS) } }],
      },
      data: { processedAt: new Date() },
    });
    if (claimed.count === 0) return new NextResponse(null, { status: 204 });

    const ctx = await loadSupervisorContext(event.businessId);
    const synthText = buildSynthText(event);
    const supervised = await runSupervisor(synthText, {
      activeRules: ctx.activeRules,
      activePolicies: ctx.activePolicies,
      onboardingState: { productCount: ctx.productCount, productsWithoutStock: ctx.productsWithoutStock, employeeCount: ctx.employeeCount },
      products: ctx.products,
      employees: ctx.employees,
      cashBalance: ctx.cashBalance,
      currency: ctx.currency,
    });
    const notification = supervised?.notification ?? null;

    if (!notification || notification.level !== "now") {
      await prisma.agentEventLog.update({
        where: { businessId_eventId: { businessId: event.businessId, eventId: event.eventId } },
        data: { status: "delivered", decisionJson: notification ? JSON.stringify(notification) : null, pushSent: 0, processedAt: new Date() },
      });
      return new NextResponse(null, { status: 204 });
    }

    // Write ChatMessage before push so owner sees it in chat even if push fails.
    const chatBody = notification.body || supervised?.answer || "Velora detectó una anomalía. Revisá el panel.";
    await writeSupervisorAlertChat({
      businessId: event.businessId,
      eventId: event.eventId,
      body: chatBody,
    });

    logA2ATransfer({
      source: "Supervisor", destination: "Owner", action: "PUSH_NOTIFICATION",
      message: "Supervisor (Pub/Sub) decide notify_now → push",
      data: { level: notification.level, title: notification.title },
      businessId: event.businessId, eventId: event.eventId,
    });
    const fan = await sendPushToOwner(event.businessId, {
      title: notification.title ? `Velora · ${notification.title}` : "Velora · Algo que te interesa",
      body: chatBody,
      url: "/dashboard",
      notificationCategory: "anomaly",
      entityId: event.eventId,
    });
    await prisma.agentEventLog.update({
      where: { businessId_eventId: { businessId: event.businessId, eventId: event.eventId } },
      data: { status: "delivered", decisionJson: JSON.stringify(notification), pushSent: fan.sent, processedAt: new Date() },
    });
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const cls = classifyError(err);
    cloudLog({
      severity: cls === "transient" ? "WARNING" : "ERROR",
      component: "System",
      action: cls === "transient" ? "PUBSUB_TRANSIENT_FAIL" : "PUBSUB_PERMANENT_FAIL",
      a2a_transfer: false,
      message: `Pub/Sub handler ${cls} error processing event ${event.eventId}`,
      data: { code: (err as { code?: string })?.code, message: err instanceof Error ? err.message.slice(0, 500) : String(err) },
      businessId: event.businessId,
      eventId: event.eventId,
    });
    return new NextResponse(null, { status: cls === "permanent" ? 204 : 503 });
  }
}
