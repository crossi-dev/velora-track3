/**
 * Prompt-injection sanitization helpers for owner-handler supervisor input.
 *
 * DB-sourced blocks (alert messages, few-shot examples) must pass through
 * these helpers before being concatenated into the Gemini Supervisor prompt.
 * Using the same sanitizeUserInput that guards the live user message ensures
 * consistent defense-in-depth across all prompt segments.
 */
import { sanitizeUserInput } from "./shared";

/**
 * Wraps user-supplied text in structural XML delimiters so that LLM prompts
 * treat the content as DATA, not as instructions.
 *
 * This is the canonical structural mitigation for OWASP LLM Top 10 #1
 * (Prompt Injection, 2025/2026 edition): use structural delimiters to
 * segregate user input from system instructions rather than relying on
 * blocklists alone. Blocklists (sanitizeUserInput) remain as defense-in-depth
 * but cannot prevent homoglyph / combining-mark bypasses.
 *
 * References:
 *   https://owasp.org/www-project-top-10-for-large-language-model-applications/
 *   https://developer.android.com/privacy-and-security/risks/ai-risks/prompt-injection
 *
 * Callers MUST use this wrapper before interpolating user content into any
 * LLM system or user message. Example:
 *
 *   const prompt = `You are a helpful assistant.\n${wrapAsUserData(userText)}`;
 *
 * Any stray closing tag in the input is escaped so user content cannot
 * break out of the wrapper. sanitizeUserInput already strips </?user_message>
 * tags; this escape is an additional layer for content that bypasses sanitize.
 */
export function wrapAsUserData(text: string): string {
  // Escape any attempt to close the wrapper tag prematurely.
  const escaped = text.replace(/<\/user_message>/gi, "</user_message_escaped>");
  return `<user_message>\n${escaped}\n</user_message>`;
}

// Hard caps for alert injection
const MAX_ALERT_ITEMS = 5;
const MAX_ALERT_ITEM_CHARS = 200;

/**
 * Sanitizes raw DB alert messages and formats them as the supervisor prefix.
 * Each message is individually sanitized and truncated to MAX_ALERT_ITEM_CHARS.
 * Returns an empty string when the array is empty.
 */
export function sanitizeAlertLines(
  messages: Array<{ text: string }>,
): string {
  if (!messages.length) return "";

  const safe = messages
    .slice(0, MAX_ALERT_ITEMS)
    .map((m) => sanitizeUserInput(m.text).slice(0, MAX_ALERT_ITEM_CHARS))
    .filter((t) => t.length > 0);

  if (!safe.length) return "";
  return `[Alertas del sistema hoy: ${safe.join(" | ")}]\n\n`;
}

/**
 * Sanitizes a few-shot block string retrieved from DB.
 * The block is a pre-formatted multi-line string; sanitizeUserInput is applied
 * to the entire block to strip any injection phrases or delimiter tags that
 * may have been stored as part of PromptExample.input / outputJson values.
 *
 * Returns an empty string when the block is empty.
 */
export function sanitizeFewShotBlock(block: string | null): string {
  if (!block) return "";
  return sanitizeUserInput(block);
}
