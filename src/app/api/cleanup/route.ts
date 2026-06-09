import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { pruneIdempotencyRecords } from "@/app/api/_lib/idempotency";
import { verifyCronSecret } from "@/app/api/_lib/route-helpers";

export const maxDuration = 30;

/**
 * Database TTL cleanup endpoint.
 * Protected by CRON_SECRET header — intended to be called by Cloud Scheduler.
 * Deletes expired sessions, old CriticalWriteEvents, old ChatMessages,
 * and old IdempotencyRecords (both stuck pending > 5min and completed > 30d).
 * AgentEventLog stuck pending > 24h get transitioned to error to free the
 * unique (businessId, eventId) slot if the publisher retries.
 */
export async function GET(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "cleanup");
  if (unauth) return unauth;

  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [sessions, events, messages, idempotency, stuckAgentEvents, oldAgentEvents] = await Promise.all([
    prisma.session.deleteMany({ where: { expires: { lt: now } } }),
    prisma.criticalWriteEvent.deleteMany({ where: { createdAt: { lt: ninetyDaysAgo } } }),
    prisma.chatMessage.deleteMany({ where: { createdAt: { lt: ninetyDaysAgo } } }),
    prisma.idempotencyRecord.deleteMany({ where: { createdAt: { lt: thirtyDaysAgo } } }),
    // Marks stuck pending events as error — keeps them for audit but frees
    // the unique (businessId, eventId) slot if the publisher retries.
    prisma.agentEventLog.updateMany({
      where: { status: "pending", createdAt: { lt: oneDayAgo } },
      data: { status: "error", errorMessage: "timeout (cleanup cron)", processedAt: now },
    }),
    // AgentEventLog completed/error rows — 90d matches CriticalWriteEvent
    // and ChatMessage retention. Pending-stuck rows are transitioned above,
    // never deleted here.
    prisma.agentEventLog.deleteMany({
      where: {
        status: { in: ["completed", "error"] },
        createdAt: { lt: ninetyDaysAgo },
      },
    }),
  ]);

  // Explicit prune of stuck pending idempotency records (> 5min) in addition
  // to the deleteMany of completed > 30d above.
  await pruneIdempotencyRecords(prisma);

  return NextResponse.json({
    deleted: {
      sessions: sessions.count,
      criticalWriteEvents: events.count,
      chatMessages: messages.count,
      idempotencyRecords: idempotency.count,
      oldAgentEvents: oldAgentEvents.count,
    },
    transitioned: {
      stuckAgentEventsToError: stuckAgentEvents.count,
    },
  });
}
