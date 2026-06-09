// ADK Equipo Agent — stateless per-request Agent emitting structured intents
// (Pattern C). Tools never mutate state; they return { intent, data, summary }
// which the RPC handler captures and forwards as dataParts. The downstream
// pipeline materializes the intents through the existing idempotent +
// audited mutation path.
//
// Rebuilt on agent-factory.ts (2026-05-25) — eliminates raw `new Agent()` call
// and enforces the instruction-as-callback rule project-wide.

import type { Agent } from "@google/adk";
import { createAdkAgent } from "@/lib/adk/agent-factory";
import { getAdkEquipoModel } from "@/lib/adk/gemini-config";
import { EQUIPO_SYSTEM_PROMPT } from "./equipo-agent-helpers";
import { buildEquipoTools } from "./equipo-agent-tools";

export function createEquipoAgent(ctx: {
  businessId: string | null;
  actorUserId: string | null;
  turnId: string;
}): Agent {
  void ctx;
  return createAdkAgent({
    name: "velora_equipo_agent",
    model: getAdkEquipoModel(),
    instruction: EQUIPO_SYSTEM_PROMPT,
    tools: buildEquipoTools(),
  });
}
