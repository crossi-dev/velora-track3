import { prisma } from "@/lib/prisma";
import { parseEmployeeEvent } from "@/lib/agent-contract";
import { getA2ATransport, getActiveTransportKind } from "@/lib/a2a-transport";
import { sendPushToOwner } from "@/app/api/_lib/owner-push";
import { writeSupervisorAlertChat } from "@/app/api/_lib/supervisor-chat-write";
import { cloudLog } from "@/lib/cloud-logger";
import { POST_COMMIT_PROTOCOL } from "@/app/api/_lib/post-commit-failure-publisher";
import type { PostCommitPayload } from "@/app/api/_lib/post-commit-failure-publisher";
import {
  replayPostCommitAction,
  isBackoffElapsed,
  logCriticalPersistentFailure,
  MAX_RETRIES,
} from "./post-commit-replay";
import { MAX_EVENT_RETRIES, serializeError, parseRetryCount } from "./event-retry-helpers";

export interface EventRetryCronResult {
  scanned: number;
  retried: number;
  pushed: number;
  unparseable: number;
  failed: number;
  postCommitReplayed: number;
  postCommitSkipped: number;
  postCommitExhausted: number;
}

const PENDING_STALE_MS = 5 * 60 * 1000;   // 5 min
const ERROR_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between retries for A2A rows
const BATCH_LIMIT = 50;

export async function runEventRetryCron(nowMs: number = Date.now()): Promise<EventRetryCronResult> {
  const result: EventRetryCronResult = {
    scanned: 0,
    retried: 0,
    pushed: 0,
    unparseable: 0,
    failed: 0,
    postCommitReplayed: 0,
    postCommitSkipped: 0,
    postCommitExhausted: 0,
  };

  const rows = await prisma.agentEventLog.findMany({
    where: {
      OR: [
        // Stuck pending — never got a response
        {
          status: "pending",
          createdAt: { lt: new Date(nowMs - PENDING_STALE_MS) },
        },
        // Error rows past cooldown
        {
          status: "error",
          OR: [
            { processedAt: null },
            { processedAt: { lt: new Date(nowMs - ERROR_COOLDOWN_MS) } },
          ],
        },
      ],
    },
    select: {
      businessId: true,
      eventId: true,
      protocol: true,
      payloadJson: true,
      status: true,
      processedAt: true,
      errorMessage: true,
    },
    take: BATCH_LIMIT,
  });

  result.scanned = rows.length;
  if (rows.length === 0) return result;

  const transport = getA2ATransport();
  const transportKind = getActiveTransportKind();

  for (const row of rows) {
    // --- Branch A: post-commit-action-failed rows (not EmployeeEvent protocol) ---
    if (row.protocol === POST_COMMIT_PROTOCOL) {
      let payload: PostCommitPayload;
      try {
        payload = JSON.parse(row.payloadJson) as PostCommitPayload;
      } catch {
        await prisma.agentEventLog.update({
          where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
          data: { status: "dropped", errorMessage: "retry: payloadJson parse failed", processedAt: new Date() },
        });
        result.unparseable += 1;
        continue;
      }

      const retries = typeof payload.retries === "number" ? payload.retries : 0;

      // Backoff gate: skip if not enough time has elapsed since last attempt.
      if (!isBackoffElapsed(retries, row.processedAt, nowMs)) {
        result.postCommitSkipped += 1;
        continue;
      }

      // Exhaustion: all retries used, mark as dropped and fire CRITICAL.
      if (retries >= MAX_RETRIES) {
        logCriticalPersistentFailure(
          row.businessId,
          row.eventId,
          payload.action,
          payload.saleId,
          payload.errorMessage,
        );
        await prisma.agentEventLog.update({
          where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
          data: {
            status: "dropped",
            errorMessage: `exhausted ${MAX_RETRIES} retries`,
            processedAt: new Date(),
          },
        });
        result.postCommitExhausted += 1;
        continue;
      }

      const replayResult = await replayPostCommitAction(row.businessId, payload);

      if (replayResult.status === "replayed") {
        await prisma.agentEventLog.update({
          where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
          data: { status: "delivered", errorMessage: null, processedAt: new Date() },
        });
        result.postCommitReplayed += 1;
      } else if (replayResult.status === "skipped") {
        // Action no longer needed (idempotency guard fired) — treat as delivered.
        await prisma.agentEventLog.update({
          where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
          data: {
            status: "delivered",
            errorMessage: `skipped: ${replayResult.reason}`,
            processedAt: new Date(),
          },
        });
        result.postCommitSkipped += 1;
      } else {
        // Failed — increment retry counter and update processedAt for next backoff window.
        const updatedPayload: PostCommitPayload = { ...payload, retries: retries + 1 };
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "POST_COMMIT_REPLAY_FAILED",
          a2a_transfer: false,
          message: `post-commit action replay failed (attempt ${retries + 1}/${MAX_RETRIES})`,
          businessId: row.businessId,
          data: { eventId: row.eventId, action: payload.action, saleId: payload.saleId, error: replayResult.error },
        });
        await prisma.agentEventLog.update({
          where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
          data: {
            status: "error",
            errorMessage: replayResult.error.slice(0, 500),
            payloadJson: JSON.stringify(updatedPayload),
            processedAt: new Date(),
          },
        });
        result.failed += 1;
      }
      continue;
    }

    // --- Branch B: standard EmployeeEvent protocol rows ---
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payloadJson);
    } catch {
      await prisma.agentEventLog.update({
        where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
        data: { status: "dropped", errorMessage: "retry: payloadJson parse failed", processedAt: new Date() },
      });
      result.unparseable += 1;
      continue;
    }

    const event = parseEmployeeEvent(parsed);
    if (!event) {
      await prisma.agentEventLog.update({
        where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
        data: { status: "dropped", errorMessage: "retry: contract validation failed", processedAt: new Date() },
      });
      result.unparseable += 1;
      continue;
    }

    try {
      const reply = await transport.publish(event);

      if (transportKind === "pubsub") {
        // Pub/Sub is async — handler will mark delivered when it processes.
        // Reset to pending so we don't retry again before the handler runs.
        // Preserve errorMessage (retry counter) so that if the pubsub-handler
        // never fires and this row comes back as stale-pending, the attempt count
        // is not lost — parseRetryCount will still see the last "retry[N]: ..." value.
        await prisma.agentEventLog.update({
          where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
          data: { status: "pending", processedAt: new Date() },
        });
        result.retried += 1;
        continue;
      }

      // Loopback — synchronous reply. Handle notification + push.
      const notification = reply.notification ?? null;
      let pushSent = 0;

      if (notification?.level === "now") {
        const chatBody = notification.body || "Revisá el panel para más detalle.";
        await writeSupervisorAlertChat({
          businessId: event.businessId,
          eventId: event.eventId,
          body: chatBody,
        });
        const fan = await sendPushToOwner(event.businessId, {
          title: notification.title ? `Velora · ${notification.title}` : "Velora · Algo que te interesa",
          body: chatBody,
          url: "/dashboard",
          notificationCategory: "anomaly",
          entityId: event.eventId ?? event.businessId,
        });
        pushSent = fan.sent;
      }

      await prisma.agentEventLog.update({
        where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
        data: {
          status: "delivered",
          errorMessage: null,
          decisionJson: notification ? JSON.stringify(notification) : null,
          pushSent,
          processedAt: new Date(),
        },
      });
      result.retried += 1;
      if (pushSent > 0) result.pushed += 1;
    } catch (err) {
      const msg = serializeError(err).slice(0, 480);
      const attemptCount = parseRetryCount(row.errorMessage) + 1;

      if (attemptCount >= MAX_EVENT_RETRIES) {
        // Exhausted — drop the row so the cron stops retrying every 5 min.
        cloudLog({
          severity: "ERROR",
          component: "System",
          action: "EVENT_RETRY_EXHAUSTED",
          a2a_transfer: false,
          message: `Event retry exhausted after ${attemptCount} attempts for ${event.type} — dropping`,
          businessId: event.businessId,
          eventId: event.eventId,
          data: { error: msg, attempts: attemptCount },
        });
        await prisma.agentEventLog.update({
          where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
          data: {
            status: "dropped",
            errorMessage: `exhausted ${attemptCount} retries: ${msg}`,
            processedAt: new Date(),
          },
        });
        result.failed += 1;
      } else {
        cloudLog({
          severity: "WARNING",
          component: "System",
          action: "EVENT_RETRY_FAILED",
          a2a_transfer: false,
          message: `Event retry failed for ${event.type} (attempt ${attemptCount}/${MAX_EVENT_RETRIES})`,
          businessId: event.businessId,
          eventId: event.eventId,
          data: { error: msg, attempts: attemptCount },
        });
        await prisma.agentEventLog.update({
          where: { businessId_eventId: { businessId: row.businessId, eventId: row.eventId } },
          data: {
            status: "error",
            errorMessage: `retry[${attemptCount}]: ${msg}`,
            processedAt: new Date(),
          },
        });
        result.failed += 1;
      }
    }
  }

  return result;
}
