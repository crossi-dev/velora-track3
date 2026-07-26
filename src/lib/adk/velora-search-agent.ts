import "server-only";
// Velora Search Sub-Agent — wraps VertexAiSearchTool inside a dedicated LlmAgent
// so it can coexist with FunctionTools in the Supervisor's tools array.
//
// ADK 2026 hard limit: you cannot mix VertexAiSearchTool (a built-in tool) with
// FunctionTool instances in the same agent's tools array — the Gemini API returns
// 400 INVALID_ARGUMENT on the first request.
//
// Canonical fix (Google ADK docs — "Agent as a Tool" pattern):
//   1. Create a dedicated sub-agent whose tools list is [VertexAiSearchTool] only.
//   2. Wrap it with AgentTool({ agent }) to produce a BaseTool the Supervisor can hold.
//   3. The Supervisor's tools array sees a normal AgentTool — no schema collision.
//
// Refs:
//   https://google.github.io/adk-docs/tools/built-in-tools/#use-built-in-tools-with-other-tools
//   https://google.github.io/adk-docs/tools/function-tools/#3-agent-as-a-tool
//   https://google.github.io/adk-docs/agents/multi-agents/
//
// Feature flag: USE_VERTEX_SEARCH=true (env). Returns null when flag is off.

import { AgentTool, VertexAiSearchTool } from "@google/adk";
import type { BaseTool } from "@google/adk";
import { createAdkAgent } from "./agent-factory";
import { getAdkCompanionModel } from "./gemini-config";
import { isVertexSearchEnabled, _datastoreIdForTesting as datastoreId } from "@/lib/vertex-search";

const SEARCH_AGENT_INSTRUCTION =
  "You are a product-search specialist for a Velora business tenant. " +
  "When invoked, call the vertex_ai_search tool with the provided query and return " +
  "its results verbatim — do not summarise, add opinions, or invent product names. " +
  "If the tool returns no results, reply with an empty array and the message: " +
  "'No products found matching this query.'";

/**
 * Builds an ADK AgentTool that wraps a dedicated VertexAiSearchTool sub-agent.
 *
 * The sub-agent (`velora_search_agent`) holds ONLY VertexAiSearchTool — the ADK
 * constraint that prevents mixing built-in tools with FunctionTools is satisfied
 * because the isolation lives at the sub-agent level. The parent Supervisor sees
 * this as a regular AgentTool (BaseTool subclass) with no schema conflict.
 *
 * Returns null when USE_VERTEX_SEARCH is disabled — callers omit null entries.
 */
export function buildVeloraSearchAgent(businessId: string): BaseTool | null {
  if (!isVertexSearchEnabled()) return null;

  const dsId = datastoreId(businessId);

  const vertexSearchTool = new VertexAiSearchTool({
    dataStoreId: dsId,
    // bypassMultiToolsLimit is not needed here: this sub-agent holds ONLY
    // VertexAiSearchTool (no FunctionTools), so there is no multi-tools conflict
    // at the sub-agent layer. The isolation is structural, not flag-based.
  });

  const searchSubAgent = createAdkAgent({
    name: "velora_search_agent",
    description:
      "Searches the tenant's grounded business knowledge (products, customers, suppliers, rules). " +
      "Use this for any natural-language lookup over business data when exact name matching is insufficient.",
    model: getAdkCompanionModel(), // Gemini Flash — cheap; only needs to relay tool output
    instruction: SEARCH_AGENT_INSTRUCTION,
    // Cast required: VertexAiSearchTool is BaseTool from @google/adk; createAdkAgent
    // accepts BaseTool[]. The runtime shape is compatible; the nominal mismatch is
    // the dual-genai import boundary documented in agent-factory.ts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dual-genai nominal mismatch at ADK boundary; runtime type is correct.
    tools: [vertexSearchTool as any],
  });

  return new AgentTool({ agent: searchSubAgent });
}
