// Signal extraction for the v2 adapter. Given a successful legacy match
// + the raw input text, derive ConfidenceSignals so the adapter can
// compute a real confidence score and split match/ambiguous.
//
// Design: signals are observable evidence from the text + the resolved
// match data, NOT a per-detector custom score. Per the plan (D2), we
// keep one shared helper rather than per-detector logic.

import { IMPERATIVE_TAIL_VERBS_RE } from "./shared";
import { normalizeForMatching } from "@/lib/normalize";
import type { ConfidenceSignal } from "./types-v2";
import type { VeloraSingleCommand } from "./shared";

// Verbs the parser considers "canonical" for each action intent. Hits
// here count as "exact-verb-match" rather than fuzzy.
const EXACT_VERB_PATTERNS: Partial<Record<string, RegExp>> = {
  register_sale: /\b(vendi|vendele|vendeme|vendo|factura(?:le|me)?|registra(?:le|me)?)\b/,
  stock_load: /\b(carg[aá]|ingres[aá]|sum[aá]|repong|repuse|recib[ií])\b/,
  stock_adjustment: /\b(descont[aá]|ajust[aá]|sum[aá]le|rest[aá]le|sac[aá])\b/,
  edit_product: /\b(cambi[aá]|actualiz[aá]|pon(?:el)?e|fij[aá])\b/,
  bulk_price_update: /\b(sub[ií]|aument[aá]|baj[aá]|reduc[ií]|pon[eé]|fij[aá]|dej[aá])\b/,
  register_movement: /\b(pag[uéeo]|cobr[éeo]|gast[éeo]|compr[éeo]|registr[aá])\b/,
};

export function extractSignals(
  rawText: string,
  command: VeloraSingleCommand,
): ConfidenceSignal[] {
  const signals: ConfidenceSignal[] = [];
  const normalized = normalizeForMatching(rawText);

  // ── Verb match ────────────────────────────────────────────────
  const verbPattern = EXACT_VERB_PATTERNS[command.intent];
  if (verbPattern && verbPattern.test(normalized)) {
    signals.push("exact-verb-match");
  }

  // ── Per-intent payload signals ────────────────────────────────
  switch (command.intent) {
    case "register_sale": {
      const data = command.data;
      const itemsResolved = data.items.length > 0 && data.items.every((i) => !!i.productId);
      if (itemsResolved) signals.push("product-resolved");
      else if (data.items.length > 0) signals.push("product-fuzzy");
      if (data.customerId) signals.push("customer-resolved");
      else if (data.customerName) signals.push("customer-fuzzy");
      if (data.items.some((i) => i.unitPrice !== null)) signals.push("numeric-payload-present");
      break;
    }
    case "stock_load": {
      const data = command.data;
      const allResolved = data.items.length > 0 && data.items.every((i) => !!i.productId);
      if (allResolved) signals.push("product-resolved");
      else if (data.items.length > 0) signals.push("product-fuzzy");
      // Only emit when quantity > 1: the parser defaults to 1 when no quantity
      // is given, so `Number.isFinite(quantity)` is always true and would
      // inflate confidence even when the user provided no explicit count.
      if (data.items.some((i) => Number.isFinite(i.quantity) && i.quantity > 1)) signals.push("numeric-payload-present");
      break;
    }
    case "stock_adjustment":
    case "edit_product":
    case "check_stock":
    case "product_price_query": {
      // These intents carry productId on success
      const data = command.data as { productId?: string | null; productName?: string };
      if (data.productId) signals.push("product-resolved");
      else if (data.productName) signals.push("product-fuzzy");
      break;
    }
    case "bulk_price_update": {
      const data = command.data;
      if (Number.isFinite(data.amount) && data.amount > 0) signals.push("numeric-payload-present");
      break;
    }
    case "register_movement": {
      const data = command.data;
      if (Number.isFinite(data.amount) && data.amount > 0) signals.push("numeric-payload-present");
      break;
    }
    default:
      // Other intents don't have well-defined payload signals; the
      // verb match alone carries them through.
      break;
  }

  // ── Cross-intent signals ──────────────────────────────────────
  // Imperative-tail: a "send/contact/call" verb appearing after the
  // primary action. Catches Bug A: "vendí 3 a Carlos mándale whatsapp"
  // — the imperative tail doesn't break the parse but it tells us a
  // second intent was meant and got dropped, so confidence falls into
  // the ambiguous band.
  if (IMPERATIVE_TAIL_VERBS_RE.test(rawText)) {
    signals.push("imperative-tail");
  }

  // Mark single-clean-segment when no compound separators AND no
  // imperative tail. Lifts confidence on the easy cases.
  const hasCompoundSeparator = /[.;]|\b(luego|despues|tambien)\b/i.test(normalized);
  if (!hasCompoundSeparator && !signals.includes("imperative-tail")) {
    signals.push("single-clean-segment");
  }

  return signals;
}
