// route-history-filter.ts — Chat history sanitization for /api/business-assistant.
// Extracted from route.ts (C2 batch) to keep route.ts under the 300-line limit.
//
// SEC-HIST-1: sanitize-then-slice (OWASP LLM Top 10 #1 2026). Clamp+sanitize per item
// BEFORE slice so 200-item window contains only clean, bounded text (max 160KB surface).

import { sanitizeUserInput } from "./shared";
import type { PendingConfirmationCarrier } from "./nlu/pending-confirmation";

// Action-chip tokens must never appear in LLM conversation context — they are
// machine protocol tokens, not natural-language utterances.
// NOTE: This list is intentionally duplicated here and in owner-handler.ts. Consolidation
// into shared.ts is deferred to the B15 batch (shared.ts is in-flight there).
export const ACTION_CHIP_PREFIXES_ROUTE = [
  "enviar_link_pago|",
  "cancelar_link_pago",
  "cliente:",
  "configurar_courier:",
  "abrir_ajustes:",
  "confirm_whatsapp:",
];

export function isRouteActionChip(t: string): boolean {
  return ACTION_CHIP_PREFIXES_ROUTE.some((p) =>
    p.endsWith("|") || p.endsWith(":") ? t.startsWith(p) : t.trim() === p,
  );
}

// Matches owner-handler.ts conversationHistory cap (800 chars per item).
const HIST_ITEM_MAX_CHARS = 800;

/**
 * Sanitizes and filters the raw chatHistory from the request body into a
 * clean, bounded recentHistory array safe for LLM context.
 *
 * Steps:
 *  1. Type-guard: discard non-object / missing-text items.
 *  2. Sanitize + clamp each item's text (XSS + injection surface reduction).
 *  3. Keep last 200 items, filter to user/reply kinds, strip manager + transient + chips.
 *  4. Return last 12 (LLM context window budget).
 */
export function buildRecentHistory(chatHistory: unknown): PendingConfirmationCarrier[] {
  const chatHistoryRaw = Array.isArray(chatHistory) ? (chatHistory as unknown[]) : [];
  const sanitized = chatHistoryRaw
    .filter(
      (m): m is { kind?: string; text?: string; source?: string; confirmationRequest?: unknown } =>
        m !== null && typeof m === "object" && typeof (m as Record<string, unknown>).text === "string",
    )
    .map((m) => ({
      ...m,
      text: sanitizeUserInput((m.text as string).slice(0, HIST_ITEM_MAX_CHARS)),
    }));

  return sanitized
    .slice(-200)
    .filter(
      (m) =>
        m.text.trim() &&
        (m.kind === "user" || m.kind === "reply") &&
        !m.text.startsWith("__transient_reply__:") &&
        m.source !== "manager" &&
        !isRouteActionChip(m.text.trim()),
    )
    .slice(-12)
    .map((m) => {
      const role: "user" | "assistant" = m.kind === "user" ? "user" : "assistant";
      if (role === "assistant" && m.confirmationRequest && typeof m.confirmationRequest === "object") {
        return {
          role,
          text: m.text,
          confirmationRequest: m.confirmationRequest as PendingConfirmationCarrier["confirmationRequest"],
        };
      }
      return { role, text: m.text };
    });
}
