// fiscal-receipt-guards — boundary predicates for trigger-fiscal-receipt.ts.
//
// Splits out the two safety checks that prevent internal agent strings from
// reaching the customer's WhatsApp:
//   1. isAgentFallbackText — catches empty/null ADK responses and known
//      fallback literals emitted by handle-fiscal-rpc.ts.
//   2. containsOwnerContent — catches ARCA setup guidance that is owner-private.
//
// Kept in a sibling module so trigger-fiscal-receipt.ts stays under 300 lines.

// ── Owner-private content markers ────────────────────────────────────────────
// C-4 FIX: These strings mark ARCA setup guidance that must never reach the
// customer's WhatsApp.
//   "Para emitir facturas electrónicas falta" → buildGuidance() fiscal-readiness.ts.
//   "https://auth.afip.gov.ar" → appears in ARCA setup steps.
//
// FIX 1: "SANDBOX" REMOVED from this list.
// handle-fiscal-rpc.ts no longer prepends "SANDBOX" to replyText. Sandbox status
// is now surfaced via a structured dataPart ({ sandboxUsed: true, sandboxLabel:
// "SANDBOX" }) on the A2A response. trigger-fiscal-receipt.ts reads
// reply.dataParts to gate owner-only routing — no substring scan needed.
// Keeping "SANDBOX" here was the root cause of 100% fiscal receipt suppression
// when ARCA_REAL_MODE=false (the default): every comprobante was silently routed
// to the generic fallback and the customer never received the itemized PDF.
const FISCAL_OWNER_CONTENT_MARKERS = [
  "Para emitir facturas electrónicas falta",
  "https://auth.afip.gov.ar",
] as const;

// ── Agent LLM fallback literals ───────────────────────────────────────────────
// Emitted by handle-fiscal-rpc.ts when the ADK runner returns null/empty or an
// internal error occurs. Uses substring match so trailing punctuation variants
// ("Sin respuesta del modelo." vs bare) are both caught by a single entry.
const FISCAL_AGENT_FALLBACK_STRINGS = [
  "Sin respuesta del modelo",
  "Error interno del Fiscal Agent",
] as const;

export function isAgentFallbackText(text: string): boolean {
  return FISCAL_AGENT_FALLBACK_STRINGS.some((s) => text.includes(s));
}

export function containsOwnerContent(text: string): boolean {
  return FISCAL_OWNER_CONTENT_MARKERS.some((marker) => text.includes(marker));
}
