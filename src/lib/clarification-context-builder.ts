/**
 * buildClarificationContext — async wiring layer for the clarification fallback.
 *
 * Enriches a bare ClarificationContext from failure signals available at call
 * sites (failed intent, tool failures, raw text, capability state). This is the
 * "wiring layer" that CRITICAL #1 in JD Step 3 Round 2 requires: buildClarification
 * (pure) was already well-built; the gap was that callers only passed { rawText }.
 *
 * Strategy (per Dialogflow CX slot filling + Wiesinger §3.3):
 *   1. Map toolFailures → missingEntities (product/customer slot names).
 *   2. Map capabilities → capabilityGap (mercadopago_not_connected, etc.).
 *   3. Extract name fragments from rawText via heuristic regex.
 *   4. Fuzzy-match fragments against DB catalog/customers (Levenshtein + substring).
 *      — Names must come from actual DB rows, NEVER invented by the LLM.
 *   5. Return populated ClarificationContext with as many fields as possible.
 *
 * References:
 *   - Dialogflow CX slot filling:
 *     https://cloud.google.com/dialogflow/cx/docs/concept/agent-design
 *   - Wiesinger et al. §3.3 self-correction loops:
 *     https://www.kaggle.com/whitepaper-agents
 */

import { prisma } from "@/lib/prisma";
import { normalizeForMatching } from "@/lib/normalize";
import type { ClarificationContext } from "@/lib/clarification-fallback";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ToolFailure {
  tool: string;
  reason: string;
  /** The entity slot name that was missing, e.g. "product" | "customer". */
  missingField?: string;
}

export interface BuildClarificationContextArgs {
  rawText: string;
  businessId: string;
  /** Pre-loaded capability flags — if absent, capability gap detection is skipped. */
  capabilities?: {
    mercadopago: boolean;
    andreani: boolean;
    arca: boolean;
  };
  /**
   * Intent the supervisor tried to fulfill before returning null/throwing.
   * E.g. "register_sale", "create_payment_link".
   */
  failedIntent?: string;
  /**
   * Tool-level failures from the supervisor or sub-agent run.
   * Each entry may carry missingField ("product" | "customer") so we know
   * which entity slot caused the failure without re-parsing the text.
   */
  toolFailures?: ToolFailure[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Extract probable product/customer name fragments from rawText via heuristics. */
function extractNameFragments(rawText: string): { product: string | null; customer: string | null } {
  const text = rawText.trim().toLowerCase();

  // Customer heuristic: "a <name>" or "para <name>" (AR sale/send patterns).
  const customerMatch = text.match(/\b(?:a|para)\s+([a-záéíóúüñ]{3,}(?:\s+[a-záéíóúüñ]{2,})?)/i);
  const customer = customerMatch ? customerMatch[1].trim() : null;

  // Product heuristic: first noun-like fragment (skip numbers + stopwords).
  // Strip leading imperative verbs and quantity words.
  const stripped = rawText
    .replace(/^(?:mandale?|enviá?|vende?|cobrale?|hacé|haceme|hace)\s+/i, "")
    .replace(/^\d+\s+/, "")
    .split(/\s+(?:a|para|de|al|del)\s+/i)[0]
    .trim();
  const product = stripped.length >= 3 ? stripped : null;

  return { product, customer };
}

/** Capability flags → canonical gap identifier string (null if no gap). */
function detectCapabilityGap(
  failedIntent: string | undefined,
  caps: BuildClarificationContextArgs["capabilities"],
): string | null {
  if (!caps || !failedIntent) return null;
  if (
    (failedIntent.includes("payment") || failedIntent.includes("pago") || failedIntent.includes("cobro")) &&
    !caps.mercadopago
  ) return "mercadopago_not_connected";
  if (failedIntent.includes("envio") || failedIntent.includes("logistica") || failedIntent.includes("andreani")) {
    if (!caps.andreani) return "andreani_not_connected";
  }
  if (failedIntent.includes("factura") || failedIntent.includes("fiscal") || failedIntent.includes("arca")) {
    if (!caps.arca) return "arca_not_connected";
  }
  return null;
}

/** Levenshtein-based substring match score (0 = no match). */
function fragmentMatchScore(fragment: string, name: string): number {
  const frag = normalizeForMatching(fragment);
  const n = normalizeForMatching(name);
  if (!frag || frag.length < 2) return 0;
  if (n === frag) return 100;
  if (n.includes(frag)) return 70;
  if (frag.includes(n)) return 60;
  // Word-level: any word in the name matches frag
  const nameWords = n.split(/\s+/);
  for (const w of nameWords) {
    if (w.length >= 3 && (w.includes(frag) || frag.includes(w))) return 50;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a populated ClarificationContext from available failure signals.
 * DB reads are guarded by try/catch — a DB error returns a minimal context
 * with at least rawText populated (fail-open: buildClarification total fallback).
 */
export async function buildClarificationContext(
  args: BuildClarificationContextArgs,
): Promise<ClarificationContext> {
  const { rawText, businessId, capabilities, failedIntent, toolFailures = [] } = args;

  // 1. Resolve missingEntities from toolFailures.
  const missingFromTools = toolFailures
    .map((f) => f.missingField)
    .filter((f): f is string => !!f && (f === "product" || f === "customer"));
  const missingEntities = [...new Set(missingFromTools)];

  // 2. Capability gap.
  const capabilityGap = detectCapabilityGap(failedIntent, capabilities) ?? undefined;

  // 3. Extract name fragments for fuzzy matching.
  const { product: productFrag, customer: customerFrag } = extractNameFragments(rawText);

  // 4. Fuzzy match fragments against DB catalog/customers.
  let candidateNames: string[] = [];
  if (businessId && (productFrag || customerFrag)) {
    try {
      const [products, customers] = await Promise.all([
        productFrag
          ? prisma.product.findMany({
              where: { businessId },
              select: { name: true },
              take: 50,
            })
          : Promise.resolve([]),
        customerFrag
          ? prisma.customer.findMany({
              where: { businessId },
              select: { name: true },
              take: 50,
            })
          : Promise.resolve([]),
      ]);

      const productMatches = productFrag
        ? products
            .map((p) => ({ name: p.name, score: fragmentMatchScore(productFrag, p.name) }))
            .filter((m) => m.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 2)
            .map((m) => m.name)
        : [];

      const customerMatches = customerFrag
        ? customers
            .map((c) => ({ name: c.name, score: fragmentMatchScore(customerFrag, c.name) }))
            .filter((m) => m.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 2)
            .map((m) => m.name)
        : [];

      candidateNames = [...productMatches, ...customerMatches].slice(0, 3);
    } catch {
      // DB error — proceed without fuzzy candidates (total fallback will handle it).
    }
  }

  return {
    rawText,
    failedIntent,
    missingEntities: missingEntities.length > 0 ? missingEntities : undefined,
    candidateNames: candidateNames.length > 0 ? candidateNames : undefined,
    capabilityGap,
  };
}
