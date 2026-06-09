// Last-resort fence/prose cleanup for the Supervisor parse-failure path.
// Extracted from supervisor-runner.ts to keep that file under the 300-LOC
// contract. Pure function — no I/O, no logging, easy to unit-test.

/**
 * Strip markdown fence wrappers AND attempt to recover the `answer` field from
 * a raw JSON-shaped string. Used as last-resort cleanup in the parse-failure
 * fallback so fenced JSON never leaks into chat as literal text.
 *
 * Bug 2026-05-27: Gemini supervisor sometimes returns:
 *   ```json
 *   {"kind":"answer","answer":"Entendido. Quedo a la espera...","actions":null,...}
 *   ```
 * safeParseJson handles the happy path, but truncated/malformed variants slip
 * through. Without this cleanup, the raw fenced output gets persisted into the
 * owner's chat as plain text — visible JSON nonsense in the demo.
 */
export function stripFenceAndProse(input: string): string {
  if (!input) return input;
  // 1) Remove leading/trailing markdown fences (with or without language tag).
  const cleaned = input
    .replace(/^\s*```(?:json)?\s*\n?/i, "")
    .replace(/\n?\s*```\s*$/i, "")
    .trim();
  // 2) If the result is a JSON object with an `answer` field, surface that field.
  //    Defensive: only unwrap when the input parses to a recognized supervisor
  //    envelope to avoid mangling legitimate prose that happens to contain {}.
  if (cleaned.startsWith("{")) {
    try {
      const obj: unknown = JSON.parse(cleaned);
      if (
        obj &&
        typeof obj === "object" &&
        typeof (obj as { answer?: unknown }).answer === "string" &&
        (obj as { answer: string }).answer.trim()
      ) {
        return (obj as { answer: string }).answer.trim();
      }
    } catch {
      // Not valid JSON — leave cleaned as is.
    }
  }
  return cleaned;
}
