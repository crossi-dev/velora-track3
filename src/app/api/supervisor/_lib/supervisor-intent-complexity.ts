// COST-N-1: Pre-classify Supervisor intent complexity to avoid wasting
// thinking tokens on simple queries (stock lookups, balance, sale close).
//
// Strategy: fast heuristic (no LLM, no latency cost). Covers ~40-50% of
// owner queries. False negatives (complex classified as simple) are safe —
// the Supervisor answers with less thinking but still has the full schema.
// False positives (simple classified as complex) waste tokens — accepted tradeoff.
//
// MINIMAL thinking is used for simple intents. MEDIUM (budget 2048) for complex.

export type IntentComplexity = "simple" | "complex";

// Keywords that strongly suggest a simple lookup or short transaction.
const SIMPLE_PATTERNS: RegExp[] = [
  /\bstock\b/i,
  /\binventario\b/i,
  /\bcaja\b/i,
  /\bbalance\b/i,
  /\bsaldo\b/i,
  /\bcuánto\b/i,
  /\bcuanto\b/i,
  /\bvendí\b/i,
  /\bvendi\b/i,
  /\bventas?\b.*hoy\b/i,
  /\bhoy.*ventas?\b/i,
  /\bmostrá\b/i,
  /\bmostra\b/i,
  /\blistá\b/i,
  /\blista\b/i,
  /\bresumen\b/i,
  /\bconfirmar?\b/i,
  /\bcerrar?\b.*venta\b/i,
  /\bventa\b.*cerrar?\b/i,
  /\bregistrar?\b.*venta\b/i,
];

// SEC-T3-HIGH-1: mutation-bearing keywords that must force complex classification
// regardless of simple-pattern matches or word count. An attacker who crafts
// "stock de X y registrar venta de 50 units" (12 words, "stock" hits SIMPLE_PATTERNS[0])
// would receive MINIMAL thinking budget without this guard — allowing the Supervisor
// to proceed with reduced reasoning on a mutation-bearing message.
// Any match here overrides a SIMPLE_PATTERNS hit.
const MUTATION_OVERRIDE_PATTERNS: RegExp[] = [
  /\bventa\b/i,
  /\bregistrar?\b/i,
  /\bcobr[ao]\b/i,
  /\bcrear?\b/i,
  /\bagregar?\b/i,
  /\bactualizar?\b/i,
  /\beliminar?\b/i,
  /\bborrar?\b/i,
  /\benviar?\s+link\b/i,
  /\bcerrar?\s+venta\b/i,
];

// Keywords that strongly suggest multi-step reasoning.
const COMPLEX_PATTERNS: RegExp[] = [
  /\bplan\b/i,
  /\bplanifik/i,
  /\banaliz/i,
  /\bcompar/i,
  /\bestrategia\b/i,
  /\bnegoci/i,
  /\bpresupuest/i,
  /\bproveedor.*(mejor|precio|ofert)/i,
  /\bmejor.*proveedor/i,
  /\bqu[eé] conviene\b/i,
  /\boptimiz/i,
  /\bpor qu[eé]\b/i,
  /\bcómo.*hacer/i,
  /\bcomo.*hacer/i,
];

/**
 * Classify the user message as `simple` (no thinking needed) or `complex`
 * (multi-step reasoning warrants the full thinking budget).
 *
 * Rules (in order):
 * 1. Complex patterns override simple patterns.
 * 2. Short messages (< 8 words) with a simple pattern → simple.
 * 3. Default → complex (safe-side: never under-think).
 */
export function classifyIntentComplexity(text: string): IntentComplexity {
  const trimmed = text.trim();

  // Complex patterns take precedence over simple patterns.
  if (COMPLEX_PATTERNS.some((p) => p.test(trimmed))) return "complex";

  if (SIMPLE_PATTERNS.some((p) => p.test(trimmed))) {
    // SEC-T3-HIGH-1: even if a simple pattern matched, a mutation verb present
    // in the same message must force complex classification — reducing the thinking
    // budget on a message that carries a write intent is a false-negative risk.
    if (MUTATION_OVERRIDE_PATTERNS.some((p) => p.test(trimmed))) return "complex";
    // Short messages (few words) are very likely simple lookups.
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount <= 20) return "simple";
  }

  return "complex";
}
