import "server-only";
// Vertex AI Search grounding for ADK agents.
//
// Velora already has a full Vertex AI Search client at `src/lib/vertex-search.ts`
// that performs per-tenant semantic product lookup via Discovery Engine. This
// file wires that capability into the Supervisor's tool list using the correct
// ADK 2026 pattern for mixing built-in tools with FunctionTools.
//
// ADK 2026 tool-mixing rule:
//   VertexAiSearchTool (a built-in tool) CANNOT share an agent's tools array
//   with FunctionTool instances — the Gemini API returns 400 INVALID_ARGUMENT.
//   Fix: isolate VertexAiSearchTool inside a dedicated sub-agent (`velora_search_agent`)
//   and expose it to the Supervisor via AgentTool. The Supervisor sees a normal
//   BaseTool; no schema collision occurs.
//
// Grounding approach (USE_VERTEX_SEARCH=true):
//   AgentTool(velora_search_agent) — the Supervisor delegates to the sub-agent,
//   which internally calls VertexAiSearchTool. ADK "Agent as a Tool" pattern.
//   Ref: https://google.github.io/adk-docs/tools/built-in-tools/#use-built-in-tools-with-other-tools
//
// Grounding approach (USE_VERTEX_SEARCH=false, default):
//   buildGroundingTools returns [] — no search capability registered.
//   Legacy FunctionTool (createVertexSearchTool) is preserved below for
//   reference and offline testing; it is NOT added to any agent's tool list
//   when USE_VERTEX_SEARCH=true (that path uses AgentTool exclusively).
//
// Feature flag: USE_VERTEX_SEARCH=true (env). Default = off.
// Requires: Vertex AI Search datastore provisioned per-tenant.
// See: docs/VERTEX_AI_SEARCH_SETUP.md for manual GCP setup steps.

import { FunctionTool } from "@google/adk";
import type { BaseTool } from "@google/adk";
import { Type } from "@google/genai";
import type { Schema } from "@google/genai";
import {
  searchProductsSemantically,
  isVertexSearchEnabled,
} from "@/lib/vertex-search";
import { buildVeloraSearchAgent } from "./velora-search-agent";

const SEARCH_PRODUCTS_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    query: {
      type: Type.STRING,
      description:
        "Natural-language product search query. Handles Argentine regional synonyms " +
        "(e.g. 'desarmador' → 'destornillador', 'gaseosa' → 'coca'). " +
        "Use for queries where exact name matching is insufficient.",
    },
    top_k: {
      type: Type.NUMBER,
      description: "Maximum number of results to return (1–10). Default 5.",
    },
  },
  required: ["query"],
};

/**
 * FunctionTool that performs semantic product search via Vertex AI Search.
 *
 * @param businessId - The Velora tenant ID. Each business has its own
 *   Discovery Engine datastore (`velora-products-{businessId}`).
 *
 * Returns null when USE_VERTEX_SEARCH is disabled — callers should omit
 * this tool from the agent's tool list in that case.
 */
export function createVertexSearchTool(businessId: string): FunctionTool | null {
  if (!isVertexSearchEnabled()) return null;

  return new FunctionTool({
    name: "search_products",
    description:
      "Semantic product search using Vertex AI Search. " +
      "Use when the user mentions a product by a regional synonym or approximate name " +
      "and the catalog fuzzy match returns no results. " +
      "Returns ranked product hits with IDs for use in register_sale or check_stock.",
    parameters: SEARCH_PRODUCTS_SCHEMA,
    execute: async (args: unknown) => {
      const input = args as { query: string; top_k?: number };
      const query = (input.query ?? "").trim();
      if (!query) {
        return { hits: [], answer: "Consulta vacía — especificá el nombre del producto." };
      }

      const topK = Math.min(Math.max(1, Math.round(input.top_k ?? 5)), 10);
      const hits = await searchProductsSemantically({ businessId, query, topK });

      if (!hits || hits.length === 0) {
        return {
          hits: [],
          answer: `No encontré productos que coincidan con "${query}" en búsqueda semántica.`,
        };
      }

      // 0.7 threshold per Google ADK / Vertex AI Search 2026 best practice:
      // default dynamic_threshold is 0.7 for grounded product-matching retrieval.
      // https://google.github.io/adk-docs/tools/google-cloud/vertex-ai-search/
      const lines = hits
        .filter((h) => h.score >= 0.7)
        .map((h) => `- ${h.name} (ID: ${h.id}, score: ${h.score.toFixed(2)})`);

      if (lines.length === 0) {
        return {
          hits,
          answer: `Encontré resultados para "${query}" pero con baja confianza. ¿Podés confirmar el nombre exacto?`,
        };
      }

      return {
        hits,
        answer: `Productos encontrados para "${query}":\n${lines.join("\n")}`,
      };
    },
  });
}

/**
 * Returns the grounding tools to register on the Supervisor agent.
 *
 * USE_VERTEX_SEARCH=false (default): returns [] — no grounding tool registered.
 *
 * USE_VERTEX_SEARCH=true: returns [AgentTool(velora_search_agent)].
 *   The AgentTool wraps a dedicated sub-agent that holds ONLY VertexAiSearchTool,
 *   satisfying ADK's hard constraint that built-in tools cannot share an agent's
 *   tools array with FunctionTools. The Supervisor sees a normal BaseTool.
 *
 * NOTE: createVertexSearchTool (the legacy FunctionTool) is intentionally NOT
 * included here — mixing it with the Supervisor's FunctionTools would trigger
 * the 400 INVALID_ARGUMENT error. It is retained above for offline testing only.
 *
 * Usage in agent construction:
 *   const groundingTools = buildGroundingTools(businessId);
 *   new Agent({ ..., tools: [...coreTool, ...groundingTools] });
 */
export function buildGroundingTools(businessId: string): BaseTool[] {
  if (!isVertexSearchEnabled()) return [];
  const agentTool = buildVeloraSearchAgent(businessId);
  return agentTool ? [agentTool] : [];
}
