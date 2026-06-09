// Customer-thread branch of ChatMessageSessionService.getSession.
//
// Extracted from session-service.ts to stay under the 300-line server/lib limit.
// Triggered when userId is an E.164 phone (Customer Agent worker invocation).
//
// Pattern (canonical Google ADK 2026): the session events are reconstructed
// from the customer-anchored ChatMessage thread written by the
// velora-whatsapp-inbound worker, providing true multi-turn memory across
// stateless Cloud Tasks invocations.
//
// ## Event.author contract (ADK 2026) — why agentName, NOT "model"
//
// The ADK Runner (node_modules/@google/adk/dist/cjs/runner/runner.js) calls
// determineAgentForResumption() which iterates session.events looking for the
// last agent event to resume from.  It explicitly checks:
//   if (event.author === "user" || !event.author) continue;
//   if (event.author === rootAgent.name) return rootAgent;
//   const agent = rootAgent.findSubAgent(event.author);
//   if (!agent) logger.warn(`Event from an unknown agent: ${event.author}, event id: ...`);
//
// And content_processor_utils.isEventFromAnotherAgent() checks:
//   return !!agentName && event.author !== agentName && event.author !== "user";
// When true, the event is converted to a "For context: [model] said: …" fragment
// injected as a user-role turn — breaking the alternating user/model structure
// Gemini requires, causing the model to produce no final text → EMPTY_REPLY.
//
// Fix: model-turn events MUST carry author = agentName (e.g. "velora_customer_agent"),
// NOT the literal string "model".
// content.role stays "model" — that is a @google/genai Content.role field, separate
// from the ADK-layer author field.
//
// Sources (verified HTTP 200 2026-05-29):
//   https://adk.dev/events/
//     "author — 'user' or the name of the agent that produced the event"
//   ADK source: node_modules/@google/adk/dist/cjs/runner/runner.js lines 305-314
//   ADK source: node_modules/@google/adk/dist/cjs/agents/processors/content_processor_utils.js lines 108-109
//
// See also session-service.ts::sessionFromMessages — same fix applied there.
//
// Sources (verified HTTP 200 2026-05-28):
//   https://google.github.io/adk-docs/sessions/session/
//   https://google.github.io/adk-docs/sessions/state/

import "server-only";
import { createEvent } from "@google/adk";
import type { Session, Event, GetSessionRequest } from "@google/adk";
import { prisma } from "@/lib/prisma";

type CustomerThreadRow = {
  id: string;
  text: string;
  source: string;
  createdAt: Date;
};

export async function loadCustomerThreadSession(
  businessId: string,
  request: GetSessionRequest,
  limit: number,
  /**
   * C1 fix (2026-05-29): exclude the current inbound turn from session history
   * to prevent it appearing twice — once in history events and once as newMessage
   * in Runner.runAsync. The worker persists the inbound row BEFORE running the
   * agent so subsequent turns load it; but for the CURRENT turn the agent already
   * receives it via newMessage, so including it in history creates a duplicate.
   * Pattern: matches clientMessageId written by the worker: "wpp-in-{messageId}".
   */
  excludeInboundMessageId?: string,
  /**
   * C2 fix (2026-05-29): the agent's own name used as Event.author for model-turn
   * history events. ADK Runner.determineAgentForResumption + isEventFromAnotherAgent
   * both require author === agentName for the agent's own turns — "model" is treated
   * as an unknown foreign agent, breaking context replay and causing EMPTY_REPLY.
   * Source: ADK source content_processor_utils.js isEventFromAnotherAgent lines 108-109.
   */
  agentName?: string,
): Promise<Session | undefined> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma client regen blocked on Windows DLL lock; Cloud Build runs prisma generate fresh so prod runtime has ChatMessage.customerId.
  const db = prisma as any;
  const customer = await db.customer.findFirst({
    where: { businessId, phone: request.userId },
    select: { id: true },
  });
  if (!customer) return undefined;

  const excludeClientMessageId = excludeInboundMessageId
    ? `wpp-in-${excludeInboundMessageId}`
    : undefined;

  const rawRows: CustomerThreadRow[] = await db.chatMessage.findMany({
    where: {
      businessId,
      customerId: customer.id,
      ...(excludeClientMessageId
        ? { clientMessageId: { not: excludeClientMessageId } }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, text: true, source: true, createdAt: true },
  });
  const rows = rawRows.reverse();
  // Return empty session (not undefined) for zero-history customers — the ADK Runner
  // throws "Session not found" / the capability-flag stateDelta can't apply onto an
  // undefined session, so a brand-new customer's first message ("hola, tenés X?")
  // degraded to the fallback reply. Same guard as session-service.ts for owners.
  if (rows.length === 0) {
    return {
      id: request.sessionId,
      appName: request.appName,
      userId: request.userId,
      state: {},
      events: [],
      lastUpdateTime: Date.now() / 1000,
    };
  }

  // Customer-thread source values map to ADK Event fields:
  //   - customer (inbound) → author: "user",  content.role: "user"
  //   - customer_assistant (reply) → author: agentName, content.role: "model"
  //
  // IMPORTANT: content.role uses the Gemini API values ("user"/"model").
  //            event.author must be "user" or the exact agent name — NOT "model".
  //            Using "model" as author triggers "Event from an unknown agent" warning
  //            in ADK Runner, and isEventFromAnotherAgent converts the turn to a
  //            "[model] said: …" fragment, breaking context and producing EMPTY_REPLY.
  //
  // Source: ADK node_modules/@google/adk/dist/cjs/runner/runner.js lines 305-314
  //         ADK node_modules/@google/adk/dist/cjs/agents/processors/content_processor_utils.js lines 108-109
  //         https://adk.dev/events/ — "author is 'user' or agent name"
  const resolvedAgentName = agentName ?? "velora_customer_agent";
  const events: Event[] = rows.map((row) =>
    createEvent({
      id: row.id,
      invocationId: row.id,
      author: row.source === "customer" ? "user" : resolvedAgentName,
      content: {
        role: row.source === "customer" ? "user" : "model",
        parts: [{ text: row.text }],
      },
      timestamp: row.createdAt.getTime() / 1000,
    }),
  );

  return {
    id: request.sessionId,
    appName: request.appName,
    userId: request.userId,
    state: {},
    events,
    lastUpdateTime: rows[rows.length - 1].createdAt.getTime() / 1000,
  };
}
