// supervisor-parser.ts
//
// PRIMARY PATH: getGeminiSupervisorModel() sets responseMimeType:"application/json" +
// responseSchema, guaranteeing clean JSON. safeParseJson() tries JSON.parse() directly
// (fast path) before engaging the legacy extraction/coercion pipeline.
//
// LEGACY / DEFENSIVE FALLBACK: fence-stripping, extractJsonObjects, coerceKind, and
// double-wrap recovery are retained for the ADK path (schema not forwarded), Flash
// fallback (uses Companion schema), and model regressions.
//
// INVARIANT: if the schema-enforced direct Gemini path returns unparseable JSON,
// supervisor-runner.ts logs severity:ERROR / action SUPERVISOR_SCHEMA_VIOLATION.

import { cloudLog } from "@/lib/cloud-logger";
import type { SupervisorResponse } from "./supervisor-response";
import { supervisorResponseSchema } from "./supervisor-schema";
import { parseChipsBundle } from "./supervisor-chips";

function extractJsonObjects(text: string): string[] {
  // Walk the string to find ALL top-level {...} blocks, handling nesting and
  // string literals. Useful when the model wraps JSON in commentary or emits
  // multiple blocks; caller picks the first parseable, substantive result.
  const blocks: string[] = [];
  let inString = false;
  let escape = false;
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start !== -1) { blocks.push(text.slice(start, i + 1)); start = -1; } }
  }
  if (blocks.length === 0) blocks.push(text);
  return blocks;
}

// Gemini occasionally emits zero-width Unicode glyphs and stray control chars
// that survive token detok and break JSON.parse. Strip at the boundary so the
// parser sees clean ASCII JSON. C0 (\x00–\x1F minus tab/newline/CR) + DEL +
// C1 + ZW family + BOM.
// eslint-disable-next-line no-control-regex
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF]/g;

function sanitizeForJson(text: string): { cleaned: string; stripped: number } {
  let stripped = 0;
  const cleaned = text.replace(INVISIBLE_RE, () => { stripped++; return ""; });
  return { cleaned, stripped };
}

// Helpers split to sibling _lib files to honor the 300-LOC area contract:
//   - supervisor-unwrap.ts  → double-wrap markdown-fence + bare-JSON unwrap
//   - supervisor-parser-coerce.ts → pre-Zod kind shape coercion
import { tryUnwrapFencedJson, tryUnwrapJsonStringValue, parseNotification } from "./supervisor-unwrap";
import { coerceKind } from "./supervisor-parser-coerce";
import { tryRecoverAnswerFromActions } from "./supervisor-answer-recovery";

function tryParseBlock(block: string): (Partial<SupervisorResponse> & { notification?: unknown; clarification?: unknown }) | null {
  try {
    const parsed = JSON.parse(block) as Partial<SupervisorResponse> & { notification?: unknown };
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    return null;
  }
  return null;
}

export function safeParseJson(raw: string): Omit<SupervisorResponse, "usedModel"> | null {
  if (!raw || !raw.trim()) return null;

  // \u2500\u2500 Fast path (schema-enforced Gemini direct call) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // When responseMimeType:"application/json" + responseSchema are active the
  // model returns a clean JSON string with no fences or prose. Try a direct
  // parse first to avoid the entire legacy pipeline on the hot path.
  // If this succeeds and passes Zod, return immediately without logging.
  // Apply invisible-char sanitization BEFORE the fast path so that U+200B and
  // similar glyphs embedded inside JSON string values are stripped consistently.
  // Without this the fast path (which never called sanitizeForJson) would return
  // visible ZWSP chars in user-facing answer strings.
  const { cleaned: sanitizedRaw } = sanitizeForJson(raw);
  const trimmedRaw = sanitizedRaw.trim();
  // Fast path for top-level JSON object (schema-enforced Gemini direct call).
  // Symmetric branch below handles top-level JSON array — ADK occasionally
  // returns [{...}] instead of {...}; unwrap single-element arrays and delegate
  // to the same parse logic so they never fall through to the legacy pipeline.
  const fastPathCandidate: string | null =
    trimmedRaw.startsWith("{") ? trimmedRaw
    : trimmedRaw.startsWith("[") ? (() => {
        try {
          const arr = JSON.parse(trimmedRaw);
          if (Array.isArray(arr) && arr.length === 1 && arr[0] && typeof arr[0] === "object") {
            return JSON.stringify(arr[0]);
          }
        } catch { /* fall through */ }
        return null;
      })()
    : null;
  if (fastPathCandidate) {
    const fastCandidate = tryParseBlock(fastPathCandidate);
    if (fastCandidate) {
      const coerced = coerceKind(fastCandidate as Record<string, unknown>);
      if (!coerced.changed &&
          (fastCandidate.kind === "actions" || fastCandidate.kind === "clarification" ||
           fastCandidate.kind === "answer" || fastCandidate.kind === "notification")) {
        // Double-wrap recovery on the fast path: Gemini on the ADK path (no
        // outputSchema) may return a valid outer JSON whose `answer` field is
        // itself a markdown-fenced or bare-JSON inner envelope. The legacy path
        // handles this below, but the fast path exits early before reaching it.
        // Detect and re-parse here so the fast path never returns a raw fence
        // or bare-JSON string as the chat answer.
        // Example (ADK double-wrap, 2026-05-27):
        //   {"kind":"answer","answer":"```json\n{\"kind\":\"answer\",\"answer\":\"Entendido.\"}\n```"}
        let unwrappedFastCandidate = fastCandidate;
        if (typeof fastCandidate.answer === "string") {
          const unwrappedFence = tryUnwrapFencedJson(fastCandidate.answer);
          if (unwrappedFence) {
            cloudLog({
              severity: "INFO",
              component: "Supervisor",
              action: "SUPERVISOR_FENCE_UNWRAPPED_FAST_PATH",
              a2a_transfer: false,
              message: "Fast path: detected markdown-fenced JSON inside `answer` — re-parsed inner content",
              data: { outerKind: fastCandidate.kind ?? null },
            });
            unwrappedFastCandidate = unwrappedFence as typeof fastCandidate;
          } else {
            const unwrappedRaw = tryUnwrapJsonStringValue(fastCandidate.answer);
            if (unwrappedRaw) {
              cloudLog({
                severity: "INFO",
                component: "Supervisor",
                action: "SUPERVISOR_BARE_JSON_UNWRAPPED_FAST_PATH",
                a2a_transfer: false,
                message: "Fast path: detected bare JSON string inside `answer` — re-parsed inner content",
                data: { outerKind: fastCandidate.kind ?? null },
              });
              unwrappedFastCandidate = unwrappedRaw as typeof fastCandidate;
            }
          }
          // If unwrap changed the candidate, re-run coerceKind so the kind
          // field reflects the inner envelope rather than the outer shell.
          if (unwrappedFastCandidate !== fastCandidate) {
            coerceKind(unwrappedFastCandidate as Record<string, unknown>);
          }
        }
        const zodResult = supervisorResponseSchema.safeParse(unwrappedFastCandidate);
        if (zodResult.success) {
          // Use Zod's validated output for the kind field — guarantees the
          // string literal type even after an unwrap mutation on the candidate.
          const validated = zodResult.data;
          return {
            kind: validated.kind,
            answer: typeof unwrappedFastCandidate.answer === "string" ? unwrappedFastCandidate.answer : "",
            actions: Array.isArray(unwrappedFastCandidate.actions) ? unwrappedFastCandidate.actions : null,
            clarification: unwrappedFastCandidate.clarification && typeof unwrappedFastCandidate.clarification === "object"
              ? { question: String((unwrappedFastCandidate.clarification as Record<string, unknown>).question ?? ""), context: String((unwrappedFastCandidate.clarification as Record<string, unknown>).context ?? "") }
              : null,
            notification: parseNotification(unwrappedFastCandidate.notification),
            chips: parseChipsBundle((unwrappedFastCandidate as Record<string, unknown>).chips),
          };
        }
      }
    }
  }

  // \u2500\u2500 Legacy / defensive fallback pipeline \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
  // Handles ADK path, Flash fallback, and model regressions where the output
  // may include markdown fences, invisible chars, or shape drift.
  // Strip invisible chars, then strip BOM and markdown fences so JSON.parse
  // sees clean ASCII.
  const { cleaned: invisibleStripped, stripped: invisibleCount } = sanitizeForJson(raw);
  const stripped = invisibleStripped.replace(/^\uFEFF/, "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const blocks = extractJsonObjects(stripped);
  if (invisibleCount > 0) {
    cloudLog({ severity: "INFO", component: "Supervisor", action: "SUPERVISOR_SANITIZED", a2a_transfer: false, message: "Stripped invisible Unicode chars before JSON parse", data: { strippedCount: invisibleCount } });
  }

  // Try each top-level block. If the first block parses to a stub (just
  // {"kind":null} with no body fields), prefer a later block that has content.
  let parsed: (Partial<SupervisorResponse> & { notification?: unknown; clarification?: unknown }) | null = null;
  for (const block of blocks) {
    const candidate = tryParseBlock(block);
    if (!candidate) continue;
    parsed = candidate;
    const hasContent = candidate.kind || candidate.answer || candidate.actions || candidate.clarification || (candidate as Record<string, unknown>).notification;
    if (hasContent) break;
  }
  if (!parsed) return null;

  // ── Double-wrap recovery ──────────────────────────────────────────────────
  // Gemini occasionally returns a syntactically valid outer JSON whose `answer`
  // field is itself a markdown-fenced JSON string — i.e. the model placed the
  // real structured response inside the fence instead of returning raw JSON.
  // Example (real production incident 2026-05-25):
  //   {"answer":"```json\n{\"kind\":\"answer\",\"answer\":\"Buen día...\"}\n```","actions":[],"chips":null}
  // In this case the outer parse succeeds but produces a nonsensical result
  // (answer = the fenced string, kind missing). Detect and recover here.
  if (typeof parsed.answer === "string") {
    // Try fenced JSON first (older Gemini double-wrap bug).
    const unwrappedFence = tryUnwrapFencedJson(parsed.answer);
    if (unwrappedFence) {
      cloudLog({
        severity: "INFO",
        component: "Supervisor",
        action: "SUPERVISOR_FENCE_UNWRAPPED",
        a2a_transfer: false,
        message: "Detected markdown-fenced JSON inside `answer` field — re-parsed inner content",
        data: { outerKind: parsed.kind ?? null },
      });
      parsed = unwrappedFence as Partial<SupervisorResponse> & { notification?: unknown; clarification?: unknown };
    } else {
      // Then try bare-JSON-string (newer Gemini 3.x double-wrap on the ADK path,
      // where we can't enforce responseSchema because outputSchema is
      // incompatible with agent-transfer sub-agents). Carlos audit 2026-05-26.
      const unwrappedRaw = tryUnwrapJsonStringValue(parsed.answer);
      if (unwrappedRaw) {
        cloudLog({
          severity: "INFO",
          component: "Supervisor",
          action: "SUPERVISOR_BARE_JSON_UNWRAPPED",
          a2a_transfer: false,
          message: "Detected bare JSON string inside `answer` field — re-parsed inner content",
          data: { outerKind: parsed.kind ?? null },
        });
        parsed = unwrappedRaw as Partial<SupervisorResponse> & { notification?: unknown; clarification?: unknown };
      }
    }
  }

  // ── ADK "answer-buried-in-actions" recovery ──────────────────────────────
  // ADK path cannot enforce responseSchema (InMemoryRunner limitation).
  // Occasionally the model emits kind=null with the reply text buried inside
  // actions[].data.text (or .message / .answer). Run this AFTER fence-strip
  // / double-wrap unwrap but BEFORE coerceKind + Zod so the rest of the
  // pipeline sees a normal {kind:"answer", answer:"..."} envelope.
  // Example: {"actions":[{"type":"reply","data":{"text":"Hola Carlos, ¿en qué te ayudo?"}}],"kind":null}
  const actionsRecovery = tryRecoverAnswerFromActions(parsed);
  if (actionsRecovery) {
    cloudLog({
      severity: "INFO",
      component: "Supervisor",
      action: "SUPERVISOR_ANSWER_RECOVERED_FROM_ACTIONS",
      a2a_transfer: false,
      message: "Recovered plain-text answer buried in actions[].data — ADK schema drift",
      data: { answerPreview: actionsRecovery.answer.slice(0, 200) },
    });
    parsed = actionsRecovery as Partial<SupervisorResponse> & { notification?: unknown; clarification?: unknown };
  }

  try {
    const coerced = coerceKind(parsed as Record<string, unknown>);
    if (coerced.changed) {
      cloudLog({ severity: "INFO", component: "Supervisor", action: "SUPERVISOR_KIND_RECOVERED", a2a_transfer: false, message: "Inferred missing/malformed kind field", data: { reason: coerced.reason, finalKind: parsed.kind } });
    }
    if (
      parsed.kind !== "actions" &&
      parsed.kind !== "clarification" &&
      parsed.kind !== "answer" &&
      parsed.kind !== "notification"
    ) {
      return null;
    }
    // Zod validation: reject responses whose actions contain non-canonical
    // intents. This blocks hallucinated or prompt-injected intent strings
    // from reaching the client-side command router. On failure we return null
    // so callers escalate / request clarification rather than silently dispatch.
    const zodResult = supervisorResponseSchema.safeParse(parsed);
    if (!zodResult.success) {
      cloudLog({
        severity: "WARNING",
        component: "Supervisor",
        action: "SUPERVISOR_SCHEMA_INVALID",
        a2a_transfer: false,
        message: "Supervisor output failed Zod validation — treating as parse failure",
        data: {
          issues: zodResult.error.issues.slice(0, 5),
          // Full raw model output (truncated) so we can diagnose shape drift without
          // re-running the prompt. Added 2026-05-20 after register_sale data field bug.
          rawBodyPreview: raw.slice(0, 1000),
        },
      });
      return null;
    }
    return {
      kind: parsed.kind,
      answer: typeof parsed.answer === "string" ? parsed.answer : "",
      actions: Array.isArray(parsed.actions) ? parsed.actions : null,
      clarification: parsed.clarification && typeof parsed.clarification === "object"
        ? { question: String((parsed.clarification as Record<string, unknown>).question ?? ""), context: String((parsed.clarification as Record<string, unknown>).context ?? "") }
        : null,
      notification: parseNotification(parsed.notification),
      chips: parseChipsBundle((parsed as Record<string, unknown>).chips),
    };
  } catch {
    return null;
  }
}
