import "server-only";
// create-tool-seams.ts — Implementation of the two trust seams added in
// feat/factory-trust-upgrade. Extracted from create-tool.ts to keep that file
// within the 300-line guardrail.
//
// Public API (re-exported via create-tool.ts):
//   deriveServerKey(turnId, toolName, input) → 32-char hex string
//   buildProhibitionsBlock(prohibitions)     → string to append to description
//
// These are pure functions — no side-effects, no imports from the app layer.
// Safe to unit-test in isolation.
//
// Sources:
//   SHA-256 derivation pattern: mirrors buildLinkIdempotencyKey in
//     adk-payments-agent.ts (SHA-256, hex.slice(0,32), "|"-joined components).
//   PROHIBICIONES pattern: sourced from Wiesinger §3.2 and ADK tool-description
//     best practices (hard constraints must appear in the description, not just
//     the system prompt, so they survive multi-tool disambiguation).

import { createHash } from "crypto";

// ── Server-side idempotency key derivation ─────────────────────────────────────
//
// Formula: SHA-256( turnId | toolName | JSON.stringify(sortedInput) )
//
// Component roles:
//   turnId      — per-request UUID generated server-side (route handler).
//                 Scopes the key to exactly one request; retries of the SAME
//                 request with the SAME input produce the SAME key (idempotent).
//   toolName    — namespaced tool name ("caja.ciclo_caja").
//                 Binds the key to THIS tool only: same turnId + same input on a
//                 DIFFERENT tool produces a DIFFERENT key → cross-intent replay
//                 is structurally impossible even if the LLM reuses args.
//   sortedInput — stable canonical JSON (keys sorted RECURSIVELY at every depth).
//                 Argument ordering by the LLM never changes the key.
//
// Output: hex string sliced to 32 chars — consistent with buildLinkIdempotencyKey.
//
// NOTE on canonicalization (jd/factory-trust-upgrade H1): we do NOT use the
// JSON.stringify(value, replacerArray) trick — that array is applied as a
// property whitelist at EVERY nesting level, so a key inside a nested object
// that isn't also a top-level key gets silently dropped, collapsing two distinct
// nested mutations to the same hash (silent wrong replay). We canonicalize with
// a recursive stable stringify instead. Arrays stay ORDER-SENSITIVE on purpose:
// sale line-items are ordered. A future tool whose array order is semantically
// irrelevant must normalize order before hashing or it risks double-execute.
function stableStringify(val: unknown): string {
  if (Array.isArray(val)) return "[" + val.map(stableStringify).join(",") + "]";
  if (val !== null && typeof val === "object") {
    const keys = Object.keys(val as Record<string, unknown>).sort();
    return (
      "{" +
      keys
        .map((k) => JSON.stringify(k) + ":" + stableStringify((val as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(val);
}

// Exported so callers can pre-compute the same key for logging/debugging.
export function deriveServerKey(turnId: string, toolName: string, input: unknown): string {
  const canonical = stableStringify(input);
  const raw = [turnId, toolName, canonical].join("|");
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// ── PROHIBICIONES block builder ────────────────────────────────────────────────
//
// Appends a numbered "PROHIBICIONES (no negociables):" block to the tool
// description. The LLM sees it as part of the description before forming any
// call — no per-tool boilerplate in execute() needed.
//
// Returns "" when the array is empty (backward compatible — nothing appended).
//
// L2: GenAI FunctionDeclaration descriptions have an undocumented ~1000-char
// limit (observed at runtime with long prohibition lists). We cap the total
// block at MAX_PROHIBITIONS_BLOCK_CHARS characters; if the full list would
// exceed this, the block is truncated with an "[…+N omitted]" marker so the
// caller gets a clean failure signal rather than a silent runtime error.
// The cap applies to the BLOCK only (after the "\n\nPROHIBICIONES" header),
// not to the base description — callers are responsible for keeping the base
// description within reasonable length.
//
// Sibling: agent-factory.seams.ts has a separate buildProhibitionsBlock for
// agent system-prompt injection (no "\n\n" prefix, no char cap needed there
// because system prompts have a much larger token budget). Keep both in sync
// if the format changes.
const MAX_PROHIBITIONS_BLOCK_CHARS = 800;

export function buildProhibitionsBlock(prohibitions: string[]): string {
  if (prohibitions.length === 0) return "";
  const header = `\n\nPROHIBICIONES (no negociables):\n`;
  const bullets: string[] = [];
  let accumulated = header.length;
  for (let i = 0; i < prohibitions.length; i++) {
    const line = `${i + 1}. ${prohibitions[i]}\n`;
    if (accumulated + line.length > MAX_PROHIBITIONS_BLOCK_CHARS) {
      const remaining = prohibitions.length - i;
      bullets.push(`[…+${remaining} omitted — prohibition list exceeds description cap]`);
      break;
    }
    bullets.push(line.trimEnd());
    accumulated += line.length;
  }
  return header + bullets.join("\n");
}
