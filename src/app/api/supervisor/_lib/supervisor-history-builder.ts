// supervisor-history-builder.ts
// Utilities for building Gemini conversation history from server-loaded turns.

/**
 * Builds a Gemini-format history array from server-loaded conversation turns.
 * Alternates user/model strictly; consecutive same-role entries are merged.
 * Always starts with a synthetic user+model seeding pair so Gemini history
 * validation passes (history must start with "user" and alternate).
 */
export function buildGeminiHistory(
  turns: ReadonlyArray<{ role: "user" | "assistant"; text: string }>,
): Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> {
  const history: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];
  for (const entry of turns) {
    const geminiRole: "user" | "model" = entry.role === "assistant" ? "model" : "user";
    const last = history[history.length - 1];
    if (last && last.role === geminiRole) {
      last.parts[0].text += `\n${entry.text}`;
    } else {
      history.push({ role: geminiRole, parts: [{ text: entry.text }] });
    }
  }
  // Ensure history ends with a model turn so the next sendMessage is user-first.
  if (history.length > 0 && history[history.length - 1].role === "user") {
    history.push({ role: "model", parts: [{ text: "Entendido." }] });
  }
  return history;
}

