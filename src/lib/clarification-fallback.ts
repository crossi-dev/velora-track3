/**
 * Clarification fallback module — shared owner + customer.
 *
 * Replaces vacuous apologies with warm, contextual clarification per
 * canonical 2026 patterns:
 *
 * - Dialogflow CX slot filling: "If users omit one or more parameters,
 *   your agent prompts them to provide values for each missing parameter."
 *   https://cloud.google.com/dialogflow/cx/docs/concept/agent-design
 *
 * - NNGroup pull revelation: "Pull revelations — help content triggered
 *   by some signal that the user would benefit from that information at
 *   that moment." https://www.nngroup.com/articles/onboarding-tutorials/
 *
 * - Intercom one-topic rule: "Stick to one main topic/feature/issue per
 *   tour." https://www.intercom.com/blog/onboarding-guide/
 *
 * - Wiesinger et al. §3.3 self-correction loops:
 *   https://www.kaggle.com/whitepaper-agents
 *
 * PURE function — no side effects, no I/O.
 * Safe to import in both server (supervisor-runner) and client (dashboard).
 */

export interface ClarificationContext {
  /** The intent we tried to fulfill, e.g. "register_sale" */
  failedIntent?: string;
  /**
   * Entity slots that are missing, e.g. ["product", "customer"].
   * Use the canonical entity names: "product" | "customer".
   */
  missingEntities?: string[];
  /**
   * Fuzzy-matched candidate names from the catalog or customer table.
   * When present, the first element is offered as a "did you mean?" hint.
   * Names must come from actual DB results — NEVER invented by the LLM.
   */
  candidateNames?: string[];
  /**
   * Identifies a prerequisite capability that is not yet configured,
   * e.g. "mercadopago_not_connected" | "andreani_not_connected".
   */
  capabilityGap?: string;
  /** What the owner/customer originally typed. */
  rawText: string;
}

export interface ClarificationResponse {
  /**
   * Warm AR Spanish question, per Intercom one-topic rule:
   * one clarification per call only.
   */
  text: string;
  /**
   * Optional tappable chips. Label max 40 chars (supervisor prompt contract).
   * Max 4 chips in the clarification context (keep it focused).
   */
  chips?: Array<{ label: string; value: string }>;
}

// ---------------------------------------------------------------------------
// ChipsBundle adapter
// ---------------------------------------------------------------------------

/**
 * Minimal ChipsBundle shape — mirrors supervisor-chips.ts and
 * src/app/dashboard/lib/types.ts without importing from /api/* (build boundary).
 * "single" is the correct kind for clarification chips: tap one, row collapses.
 */
export interface ClarificationChipsBundle {
  kind: "single";
  options: Array<{ label: string; value: string }>;
}

/**
 * Convert the flat `ClarificationResponse.chips` array to the canonical
 * `ChipsBundle` wire format expected by the chat UI.
 *
 * - kind is always "single" (clarification = one choice at a time, per
 *   Intercom one-topic rule + Dialogflow CX slot-filling pattern).
 * - Labels > 40 chars are truncated per the supervisor prompt contract.
 * - Empty or null input returns null so callers can treat it as "no chips".
 *
 * Reference: supervisor-chips.ts parseChipsBundle invariants.
 */
export function toClarificationChipsBundle(
  chips: Array<{ label: string; value: string }> | null | undefined,
): ClarificationChipsBundle | null {
  if (!chips || chips.length === 0) return null;
  const options = chips
    .filter((c) => c.label && c.value)
    .map((c) => ({
      label: c.label.slice(0, 40),
      value: c.value,
    }));
  if (options.length === 0) return null;
  return { kind: "single", options };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractFragment(rawText: string): string {
  // Return the first 40 chars of rawText, trimmed, as a user-facing fragment.
  return rawText.trim().slice(0, 40);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a warm, contextual clarification response.
 *
 * Priority order (first match wins):
 *   1. Capability gap — prerequisite not configured
 *   2. Both product + customer missing
 *   3. Product missing, customer present (or unknown)
 *      3a. With fuzzy match → "did you mean?"
 *      3b. Without fuzzy match → create or rephrase
 *   4. Customer missing, product present (or unknown)
 *   5. Total fallback — schema fail / completely unparseable
 *
 * Per Intercom one-topic rule: always ONE clarification question per call.
 */
export function buildClarification(ctx: ClarificationContext): ClarificationResponse {
  const { missingEntities = [], candidateNames = [], capabilityGap, rawText } = ctx;
  const fragment = extractFragment(rawText);

  const missingProduct = missingEntities.includes("product");
  const missingCustomer = missingEntities.includes("customer");

  // ── 1. Capability gap ──────────────────────────────────────────────
  if (capabilityGap) {
    return buildCapabilityGapClarification(capabilityGap);
  }

  // ── 2. Both product + customer missing ────────────────────────────
  if (missingProduct && missingCustomer) {
    // Use raw fragment to give context; names come from rawText, not LLM.
    const productHint = candidateNames[0] ?? null;
    if (productHint) {
      // Fuzzy match on at least product — offer it.
      return {
        text: `No encontré el producto exacto ni el cliente. ¿Quisiste decir '${productHint}'?`,
        chips: [
          { label: "Sí, ese", value: `sí, ${productHint}` },
          { label: "No, reescribir", value: "reescribir pedido" },
          { label: "Crear producto", value: "crear producto" },
        ],
      };
    }
    return {
      text: `No encontré producto ni cliente en '${fragment}'. ¿Qué creamos primero?`,
      chips: [
        { label: "Crear producto", value: "crear producto" },
        { label: "Agregar cliente", value: "agregar cliente" },
        { label: "Reescribir todo", value: "reescribir pedido" },
      ],
    };
  }

  // ── 3. Product missing ─────────────────────────────────────────────
  if (missingProduct) {
    // 3a. Fuzzy match available
    if (candidateNames.length > 0) {
      const best = candidateNames[0];
      return {
        text: `¿Quisiste decir '${best}'?`,
        chips: [
          { label: "Sí, ese", value: `sí, ${best}` },
          { label: "No", value: "no, otro producto" },
        ],
      };
    }
    // 3b. No fuzzy match
    return {
      text: `No encontré '${fragment}' en tu catálogo. ¿Lo creo o lo reescribís?`,
      chips: [
        { label: "Crear", value: "crear producto" },
        { label: "Reescribir", value: "reescribir pedido" },
      ],
    };
  }

  // ── 4. Customer missing ────────────────────────────────────────────
  if (missingCustomer) {
    if (candidateNames.length > 0) {
      const best = candidateNames[0];
      return {
        text: `¿Quisiste decir el cliente '${best}'?`,
        chips: [
          { label: "Sí, ese", value: `sí, ${best}` },
          { label: "No, otro", value: "no, otro cliente" },
        ],
      };
    }
    return {
      text: `No encontré a '${fragment}' entre tus clientes. ¿Lo cargo o ya está con otro nombre?`,
      chips: [
        { label: "Cargar cliente", value: "agregar cliente" },
        { label: "Reescribir nombre", value: "reescribir pedido" },
      ],
    };
  }

  // ── 5. Total fallback ──────────────────────────────────────────────
  // LLM schema fail, completely unparseable, or no specific entity info.
  // Per Wiesinger §3.3: offer structured re-entry points, not a blank apology.
  return buildTotalFallback();
}

// ---------------------------------------------------------------------------
// Named sub-builders (keep buildClarification under 30 lines of logic)
// ---------------------------------------------------------------------------

function buildCapabilityGapClarification(gap: string): ClarificationResponse {
  if (gap === "mercadopago_not_connected") {
    return {
      text: "Para esto necesito que conectes MercadoPago. ¿Lo configuramos ahora o más tarde?",
      chips: [
        { label: "Configurar ahora", value: "connect_mp" },
        { label: "Más tarde", value: "omitir por ahora" },
      ],
    };
  }
  if (gap === "andreani_not_connected") {
    return {
      text: "Para cotizar envíos necesito las credenciales de Andreani. ¿Las configuramos?",
      chips: [
        { label: "Configurar Andreani", value: "andreani_connect" },
        { label: "Más tarde", value: "omitir por ahora" },
      ],
    };
  }
  if (gap === "arca_not_connected") {
    return {
      text: "Para emitir factura necesito tu CUIT y certificado de AFIP. ¿Lo conectamos?",
      chips: [
        { label: "Conectar AFIP", value: "arca_connect" },
        { label: "Más tarde", value: "omitir por ahora" },
      ],
    };
  }
  // Generic capability gap
  return {
    text: "Necesito configurar una integración antes de continuar. ¿Lo hacemos ahora?",
    chips: [
      { label: "Configurar", value: "open_settings" },
      { label: "Más tarde", value: "omitir por ahora" },
    ],
  };
}

function buildTotalFallback(): ClarificationResponse {
  return {
    text: "No te entendí del todo. Decímelo de otra forma o probá uno de estos:",
    chips: [
      { label: "Cargar producto", value: "cargar producto" },
      { label: "Hacer venta", value: "hacer venta" },
      { label: "Cobrar", value: "cobrar" },
    ],
  };
}
