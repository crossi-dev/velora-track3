import "server-only";
// ADK Session reconstruction from ChatMessage rows.
// Extracted from session-service.ts to honor the 300-line file-size contract.
//
// Event.author contract (ADK 2026):
//   ADK Runner.determineAgentForResumption + isEventFromAnotherAgent both require
//   event.author === agentName for the agent's own turns. Using the literal string
//   "model" as author causes "Event from an unknown agent" warnings and breaks
//   context replay (the event is treated as a foreign-agent turn and wrapped as
//   "[model] said: …" in a user-role Content, corrupting the alternating user/model
//   turn structure Gemini requires → empty final response).
//
//   content.role stays "model" — that is the @google/genai Content.role field
//   (Gemini API contract), separate from the ADK-layer author field.
//
// Sources (verified HTTP 200 2026-05-29):
//   https://adk.dev/events/ — "author is 'user' or the agent name"
//   ADK source: node_modules/@google/adk/dist/cjs/runner/runner.js lines 305-314
//   ADK source: node_modules/@google/adk/dist/cjs/agents/processors/content_processor_utils.js lines 108-109

import { createEvent } from "@google/adk";
import type { Session, Event } from "@google/adk";

// Reconstruct ADK Sessions from ChatMessage rows using the createEvent helper.
export function sessionFromMessages(
  appName: string,
  userId: string,
  sessionId: string,
  rows: Array<{ id: string; text: string; source: string; createdAt: Date }>,
  agentName: string,
): Session {
  const events: Event[] = rows.map((row) =>
    createEvent({
      id: row.id,
      invocationId: row.id,
      // author: "user" for user turns; agentName (not "model") for model turns.
      // ADK isEventFromAnotherAgent: author !== agentName && author !== "user" → foreign event.
      author: row.source === "user" ? "user" : agentName,
      content: {
        // content.role uses Gemini API values: "user" or "model". Separate from author.
        role: row.source === "user" ? "user" : "model",
        parts: [{ text: row.text }],
      },
      timestamp: row.createdAt.getTime() / 1000,
    }),
  );

  return {
    id: sessionId,
    appName,
    userId,
    state: {},
    events,
    lastUpdateTime:
      rows.length > 0
        ? rows[rows.length - 1].createdAt.getTime() / 1000
        : Date.now() / 1000,
  };
}
