// delete_product Fast Path detector — keeps "borrá el producto X" off the
// Gemini Pro Slow Path (~29s cross-region). The supervisor was taking
// long for a conversational ack on a destructive op that never needed
// LLM reasoning in the first place.
//
// Scope intentionally narrow:
//   - Verb must be one of {borr, elimin, sac, quit, remov, dar de baja}.
//   - Optional `producto` / `articulo` / `item` noun (branch 1).
//   - OR bare noun where the fragment matches EXACTLY one catalog entry (branch 2).
//   - Required product fragment, resolvable via productInfoDirectory.
//
// Conservative — if the product fragment is missing, multi-match, or
// doesn't resolve to a single catalog entry, fall through to LLM (which
// can ask a clarifying question). False-positives on a destructive op
// are catastrophic; better to be slow occasionally.
//
// We DON'T match `borrá la última venta` here — that's `undo` (handled
// earlier in detect.ts with priority 1). The undo detector requires
// "última"/"anterior" qualifiers; we deliberately exclude those here.

import { normalizeForMatching } from "@/lib/normalize";

export interface DeleteProductFastPathMatch {
  productText: string;
}

// Verbs that signal deletion. Note: we use `\w*` suffix to tolerate
// voseo conjugations (borrá → borr, eliminá → elimin, etc.) — same
// pattern as DETERMINISTIC_HINT_RE.
const DELETE_VERB = "(?:borr\\w*|elimin\\w*|sac\\w*|quit\\w*|remov\\w*|tira\\w*|dar\\s+de\\s+baja)";

// Undo qualifiers — if present, this is NOT delete_product, it's undo.
// The undo detector runs earlier in detect.ts; we defer to it.
const UNDO_QUALIFIER_RE = /\b(ultima|ultimas|ultimo|ultimos|anterior|anteriores|previa|previas|previo|previos)\b/i;

// Bulk qualifiers — if present, treat as multi-delete (LLM handles for now).
const BULK_QUALIFIER_RE = /\b(todo|todos|todas|toda)\b/i;

// Branch 1 (highest confidence): explicit `producto`/`articulo`/`item` noun.
const WITH_NOUN_RE = new RegExp(
  `${DELETE_VERB}\\s+(?:el\\s+|la\\s+|este\\s+|esta\\s+)?(?:producto|articulo|item|art[ií]culo)\\s+(.+?)\\s*\\.?\\s*$`,
  "i",
);

// Branch 2 (bare noun): "borrá (el/la) NAME" — no explicit "producto" noun.
// ONLY safe when the fragment matches EXACTLY one product in the catalog
// (case-insensitive, normalized). Fuzzy/partial matches MUST fall to LLM.
const BARE_NOUN_RE = new RegExp(
  `^${DELETE_VERB}\\s+(?:el\\s+|la\\s+|los\\s+|las\\s+)?(.+?)\\s*\\.?\\s*$`,
  "i",
);

// Cleaner: strip trailing punctuation + leading articles.
function cleanProductFragment(raw: string): string {
  return raw
    .trim()
    .replace(/^(?:el|la|los|las|un|una|unos|unas)\s+/i, "")
    .replace(/[,.;:?!]+$/g, "")
    .trim();
}

export function detectDeleteProductFastPath(
  text: string,
  catalog?: Array<{ id: string; name: string }>,
): DeleteProductFastPathMatch | null {
  if (!text || text.trim().length === 0) return null;

  const normalized = normalizeForMatching(text).replace(/\s+/g, " ").trim();

  // Defer to undo detector when undo qualifiers are present.
  if (UNDO_QUALIFIER_RE.test(normalized)) return null;
  // Defer to LLM when bulk qualifiers are present (multi-delete UX needs
  // an explicit clarification flow — out of scope for a deterministic
  // single-product Fast Path).
  if (BULK_QUALIFIER_RE.test(normalized)) return null;

  // Branch 1: explicit noun (highest confidence — no catalog needed).
  const withNounMatch = normalized.match(WITH_NOUN_RE);
  if (withNounMatch?.[1]) {
    const productText = cleanProductFragment(withNounMatch[1]);
    if (productText && productText.length >= 2) return { productText };
  }

  // Branch 2: bare noun — ONLY when catalog provided AND fragment resolves
  // to exactly ONE product via case-insensitive exact match.
  // Any ambiguity (0 or >1 matches) falls through to LLM for safety.
  if (catalog && catalog.length > 0) {
    const bareMatch = normalized.match(BARE_NOUN_RE);
    if (bareMatch?.[1]) {
      const fragment = cleanProductFragment(bareMatch[1]);
      if (!fragment || fragment.length < 2) return null;
      const hits = catalog.filter(
        (p) => normalizeForMatching(p.name) === fragment,
      );
      if (hits.length === 1) return { productText: fragment };
    }
  }

  return null;
}
