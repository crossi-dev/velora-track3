// Defensive client-side parse for chip payloads coming off the wire (assistant
// SSE response, /api/chat-history GET). Mirrors the server-side validator in
// src/app/api/supervisor/_lib/supervisor-chips.ts but stays in dashboard land
// to avoid the build-boundary import. Returns a sanitised ChipsBundle or null.

import type { ChipsBundle, ChipOption, ChipAction, ChipKind } from "../types";

const VALID_KINDS: readonly ChipKind[] = ["single", "multi", "action"];
const VALID_ACTIONS: readonly ChipAction[] = ["subscribe_push"];
const MAX_OPTIONS = 8;
const MAX_LABEL_LEN = 40;
// 512 allows payment-link chip values that carry full MP checkout URLs
// (typically 150-300 chars). All other chip values are well under 80 chars.
const MAX_VALUE_LEN = 512;

export function parseChipsBundle(raw: unknown): ChipsBundle | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (typeof kind !== "string" || !(VALID_KINDS as readonly string[]).includes(kind)) return null;
  const options = obj.options;
  if (!Array.isArray(options) || options.length === 0) return null;

  const cleaned: ChipOption[] = [];
  for (const opt of options.slice(0, MAX_OPTIONS)) {
    if (!opt || typeof opt !== "object") continue;
    const o = opt as Record<string, unknown>;
    const label = typeof o.label === "string" ? o.label.slice(0, MAX_LABEL_LEN).trim() : "";
    const value = typeof o.value === "string" ? o.value.slice(0, MAX_VALUE_LEN).trim() : label;
    if (!label) continue;
    const action = typeof o.action === "string" && (VALID_ACTIONS as readonly string[]).includes(o.action)
      ? (o.action as ChipAction)
      : undefined;
    const next: ChipOption = { label, value: value || label };
    if (action) next.action = action;
    cleaned.push(next);
  }
  if (cleaned.length === 0) return null;
  return { kind: kind as ChipKind, options: cleaned };
}
