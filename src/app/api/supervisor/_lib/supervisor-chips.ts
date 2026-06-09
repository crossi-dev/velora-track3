// Tappable chip contract — UI affordance for the supervisor's structured
// quick replies (T2/T3/T5 onboarding, post-T6 push primer). The supervisor
// emits the labels in `chips`; the client renders buttons under the bubble
// and re-submits the chosen value(s) as the next user turn.
//
// Three flavours:
//   - "single" : tap one option → sends value back, row disabled afterwards.
//   - "multi"  : toggle multiple → "Listo" confirm sends the joined values.
//   - "action" : option carries a side-effect (e.g. "subscribe_push" runs
//                the VAPID subscribe flow before the value is echoed back).
//
// Additive only — `chips` is optional everywhere, so existing replies that
// don't carry the field render exactly as before.
export type ChipKind = "single" | "multi" | "action";

export type ChipAction = "subscribe_push";

export interface ChipOption {
  label: string;
  value: string;
  action?: ChipAction;
}

export interface ChipsBundle {
  kind: ChipKind;
  options: ChipOption[];
}

const VALID_KINDS: readonly ChipKind[] = ["single", "multi", "action"];
const VALID_ACTIONS: readonly ChipAction[] = ["subscribe_push"];
const MAX_OPTIONS = 8;
const MAX_LABEL_LEN = 40;
// 512 allows payment-link chip values that carry full MP checkout URLs
// (typically 150-300 chars). All other chip values are well under 80 chars.
const MAX_VALUE_LEN = 512;

// Defensive coercion — accept the raw model output as `unknown`, return a
// sanitised ChipsBundle or null. Used by the parser and by anything that
// reads chips off the wire (DB JSON column, /api/business-assistant).
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
