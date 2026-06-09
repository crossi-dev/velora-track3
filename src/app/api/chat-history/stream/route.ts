// SSE endpoint — replaces the 30s setInterval manager-message poll in
// useChatHistory.ts. Delivers new manager (source="manager") messages to the
// client in real time over a persistent HTTP stream.
//
// Pattern for other SSE migrations:
//   - export const runtime = "nodejs" + dynamic = "force-dynamic" (required for Cloud Run)
//   - Return a Response with ReadableStream immediately — DO NOT await async work before returning
//   - Send `:keepalive\n\n` every 25s — Cloud Run kills idle connections at 300s
//   - Poll DB inside start() without awaiting; use controller.close() on client disconnect
//   - Wire req.signal.addEventListener("abort") for clean teardown
//
// TODO: migrate useCobroEnrichedStatus polling → SSE following this pattern
// TODO: migrate useCobroStatusPoll (payment-intents enriched status) → SSE following this pattern
// TODO: migrate any future manager-push polling → SSE following this pattern

import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { checkRateLimit, bypassIfTester } from "@/app/api/_lib/route-helpers";
import { chatMessageVisibilityFilter } from "@/app/api/business-assistant/_lib/visibility-filter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Cloud Run idle-connection timeout is 300s. Keepalive must fire before that.
// 25s gives a comfortable margin even under transient jitter.
const KEEPALIVE_INTERVAL_MS = 25_000;

// DB poll cadence inside the SSE loop. 10s means new manager messages surface
// within 10s — much better UX than the previous 30s setInterval, at negligible
// extra DB cost (a single indexed query per interval per open connection).
const DB_POLL_INTERVAL_MS = 10_000;

const RESET_KIND = "chat_reset";

interface ChatRow {
  clientMessageId: string;
  kind: string;
  source: string | null;
  text: string;
  chips: unknown;
  createdAt: Date;
}

function encodeSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function encodeKeepalive(): string {
  return `: keepalive\n\n`;
}

async function fetchManagerMessages(
  businessId: string,
  actorEmployeeId: string | null | undefined,
  since: Date,
): Promise<ChatRow[]> {
  const actorKind = actorEmployeeId ? "employee" : "owner";

  const latestReset = await prisma.chatMessage.findFirst({
    where: { businessId, kind: RESET_KIND },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const clearedAt = latestReset?.createdAt ?? null;

  return prisma.chatMessage.findMany({
    where: {
      businessId,
      kind: { not: RESET_KIND },
      source: "manager",
      createdAt: { gt: since },
      ...(clearedAt ? { createdAt: { gte: clearedAt } } : {}),
      ...chatMessageVisibilityFilter({ kind: actorKind, employeeId: actorEmployeeId ?? undefined }),
    },
    orderBy: { createdAt: "asc" },
    take: 20,
    select: {
      clientMessageId: true,
      kind: true,
      source: true,
      text: true,
      chips: true,
      createdAt: true,
    },
  });
}

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) {
    return new Response(
      encodeSSE("error", { code: "UNAUTHORIZED", message: "Authentication required." }),
      {
        status: 401,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      },
    );
  }

  // Slightly more permissive than the polling route — one persistent connection
  // per business replaces many short polls, so 10/min is plenty.
  const rateLimited = checkRateLimit(req, "chat-sse", 10, 60, {
    ...bypassIfTester(actor),
    actorKey: actor.businessId ?? undefined,
  });
  if (rateLimited) {
    return new Response(
      encodeSSE("error", { code: "RATE_LIMITED", message: "Too many SSE connections." }),
      {
        status: 429,
        headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      },
    );
  }

  const { businessId, actorEmployeeId } = actor;

  const encoder = new TextEncoder();
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      // Teardown helper — idempotent.
      const teardown = () => {
        if (closed) return;
        closed = true;
        if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
        if (pollTimer !== null) clearInterval(pollTimer);
        try {
          controller.close();
        } catch {
          // Already closed — ignore.
        }
      };

      // Respect client disconnect (browser tab close, component unmount, etc.)
      req.signal.addEventListener("abort", teardown);

      if (!businessId) {
        // No business context — send an empty snapshot and close gracefully.
        controller.enqueue(encoder.encode(encodeSSE("snapshot", { messages: [] })));
        teardown();
        return;
      }

      // Cursor: only send messages newer than connection time.
      let cursor = new Date();

      // --- Initial snapshot: manager messages from the last 24h ---
      void (async () => {
        try {
          // Look back 24h so the client gets messages it may have missed
          // between the last page load and now.
          const snapshotSince = new Date(Date.now() - 24 * 60 * 60 * 1000);
          const rows = await fetchManagerMessages(businessId, actorEmployeeId, snapshotSince);
          if (closed) return;
          const messages = rows.map((row) => ({
            id: `msg:${row.clientMessageId}`,
            source: row.source,
            kind: row.kind,
            text: row.text,
            chips: row.chips ?? null,
            createdAt: row.createdAt.toISOString(),
          }));
          controller.enqueue(encoder.encode(encodeSSE("snapshot", { messages })));
          // Advance cursor past snapshot rows so the poll loop doesn't re-emit them.
          if (rows.length > 0) {
            cursor = rows[rows.length - 1].createdAt;
          }
        } catch (err) {
          if (!closed) {
            controller.enqueue(
              encoder.encode(encodeSSE("error", { code: "SNAPSHOT_FAILED", message: String(err) })),
            );
          }
        }
      })();

      // --- Keepalive: every 25s to prevent Cloud Run idle-connection kill ---
      keepaliveTimer = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeKeepalive()));
        } catch {
          teardown();
        }
      }, KEEPALIVE_INTERVAL_MS);

      // --- DB poll: check for new manager messages every 10s ---
      pollTimer = setInterval(() => {
        if (closed) return;
        void (async () => {
          try {
            const rows = await fetchManagerMessages(businessId, actorEmployeeId, cursor);
            if (closed || rows.length === 0) return;
            const messages = rows.map((row) => ({
              id: `msg:${row.clientMessageId}`,
              source: row.source,
              kind: row.kind,
              text: row.text,
              chips: row.chips ?? null,
              createdAt: row.createdAt.toISOString(),
            }));
            controller.enqueue(encoder.encode(encodeSSE("delta", { messages })));
            cursor = rows[rows.length - 1].createdAt;
          } catch {
            // Non-fatal — next poll tick will retry. Avoid crashing the stream.
          }
        })();
      }, DB_POLL_INTERVAL_MS);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Prevent Nginx/proxies from buffering the SSE stream.
      "X-Accel-Buffering": "no",
    },
  });
}
