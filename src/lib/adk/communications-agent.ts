// communications-agent.ts — ADK Agent for outbound notifications.
//
// Scope: Web Push (VAPID/FCM), in-app ChatMessage writes for owner.
// Out of scope: WhatsApp (kept as thin lib, not routed through this agent).
//
// Pattern C: tools emit { intent, data, summary } — no direct mutations.
// The caller captures intents and materializes them through the existing
// idempotent + audited mutation path.
//
// Model: Gemini Flash (lightweight tasks — no Pro budget needed here).

import type { Agent } from "@google/adk";
import { createAdkAgent } from "@/lib/adk/agent-factory";
import { getAdkCommunicationsModel } from "@/lib/adk/gemini-config";
import { COMMUNICATIONS_SYSTEM_PROMPT } from "./communications-agent.helpers";
import { buildCommunicationsTools } from "./communications-agent.tools";

export function createCommunicationsAgent(): Agent {
  return createAdkAgent({
    name: "velora_communications_agent",
    model: getAdkCommunicationsModel(),
    instruction: COMMUNICATIONS_SYSTEM_PROMPT,
    tools: buildCommunicationsTools(),
  });
}
