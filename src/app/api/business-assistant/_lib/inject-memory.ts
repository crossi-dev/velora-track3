import "server-only";
// Memory injection for the Supervisor system prompt.
// Retrieves up to 5 relevant memories from Memory Bank and returns a
// formatted block to prepend to the supervisor context.
//
// Returns empty string when Memory Bank is disabled or on any error,
// so zero-cost when the feature flag is off.

import { retrieveOwnerMemories, isMemoryBankEnabled } from "@/lib/agent-memory-bank";

/**
 * Build a formatted memory block for the supervisor user message context.
 * Returns "" when no memories found or the feature is disabled.
 *
 * The block is injected BEFORE the user message — the supervisor sees it as
 * authoritative context about this owner's learned preferences.
 */
export async function buildMemoryInjection(
  businessId: string,
  query: string,
): Promise<string> {
  if (!isMemoryBankEnabled()) return "";
  if (!businessId || !query.trim()) return "";

  let memories: Awaited<ReturnType<typeof retrieveOwnerMemories>>;
  try {
    memories = await retrieveOwnerMemories(businessId, query);
  } catch {
    // Memory Bank errors must never block the supervisor turn.
    return "";
  }
  if (memories.length === 0) return "";

  const lines = memories.map((m) => {
    const date = new Date(m.createTime).toLocaleDateString("es-AR", {
      day: "2-digit",
      month: "2-digit",
      year: "2-digit",
    });
    return `- [${date}] ${m.content}`;
  });

  return `\n\nPREFERENCIAS APRENDIDAS DEL DUEÑO:\n${lines.join("\n")}`;
}
