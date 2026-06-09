/**
 * missing-business-data.ts
 *
 * Single source of truth for "what business data is missing and what does it block".
 * Pure module — no DB calls, no side-effects. Caller passes the already-loaded business.
 *
 * Consumed by:
 *   1. Supervisor prompt injection (awareness context)
 *   2. NLU shipment guard (precondition for courier intents)
 *   3. Agent-tool precondition checks (payment links, messaging, invoicing)
 */

// ---------------------------------------------------------------------------
// Input type — structural, permissive.
// Accepts a Prisma Business row OR a SupervisorBusinessContext partial.
// Only the fields actually read by this module are required.
// ---------------------------------------------------------------------------

export interface BusinessDataInput {
  postalCode?: string | null;
  paymentProvider?: string | null;
  alias?: string | null;
  whatsappPhone?: string | null;
  cuit?: string | null;
}

// ---------------------------------------------------------------------------
// Per-capability result shape
// ---------------------------------------------------------------------------

export interface CapabilityStatus {
  /** True when this capability cannot function due to missing configuration. */
  blocked: boolean;
  /** Human-readable field names that are absent (empty when not blocked). */
  missingFields: string[];
  /**
   * Short Rioplatense-Spanish sentence the Supervisor can surface to the owner
   * to request the missing data. Empty string when not blocked.
   */
  ownerPrompt: string;
}

// ---------------------------------------------------------------------------
// Aggregate result
// ---------------------------------------------------------------------------

export interface MissingBusinessData {
  /** Andreani / OCA shipping quotes — requires origin postalCode. */
  shipping: CapabilityStatus;
  /**
   * Alias/CBU payment links — only relevant when paymentProvider === "alias_cbu".
   * MP is async-verified elsewhere; treated as configured here.
   */
  paymentLinks: CapabilityStatus;
  /** WhatsApp messaging to customers — requires whatsappPhone. */
  customerMessaging: CapabilityStatus;
  /** Coarse invoicing readiness — requires cuit (deep fiscal check is separate). */
  invoicing: CapabilityStatus;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

// ---------------------------------------------------------------------------
// Core pure function
// ---------------------------------------------------------------------------

export function getMissingBusinessData(business: BusinessDataInput): MissingBusinessData {
  // --- shipping ---
  const shippingBlocked = isBlank(business.postalCode);

  // --- paymentLinks ---
  const isAliasCbu = business.paymentProvider === "alias_cbu";
  const paymentLinksBlocked = isAliasCbu && isBlank(business.alias);

  // --- customerMessaging ---
  // whatsappPhone === "" is used as a "deferred" sentinel in the supervisor context
  // (see load-context.ts line 196: whatsappPhoneSet allows "" as set).
  // Here we treat empty string as missing because an empty number is not dialable.
  const messagingBlocked = isBlank(business.whatsappPhone);

  // --- invoicing ---
  const invoicingBlocked = isBlank(business.cuit);

  return {
    shipping: shippingBlocked
      ? {
          blocked: true,
          missingFields: ["postalCode"],
          ownerPrompt:
            "Para cotizar envíos necesito el código postal de tu negocio — ¿cuál es?",
        }
      : { blocked: false, missingFields: [], ownerPrompt: "" },

    paymentLinks: paymentLinksBlocked
      ? {
          blocked: true,
          missingFields: ["alias"],
          ownerPrompt:
            "Para generar links de pago por alias necesito tu alias o CBU — ¿me lo pasás?",
        }
      : { blocked: false, missingFields: [], ownerPrompt: "" },

    customerMessaging: messagingBlocked
      ? {
          blocked: true,
          missingFields: ["whatsappPhone"],
          ownerPrompt:
            "Para enviarle mensajes a los clientes necesito el número de WhatsApp del negocio — ¿cuál es?",
        }
      : { blocked: false, missingFields: [], ownerPrompt: "" },

    invoicing: invoicingBlocked
      ? {
          blocked: true,
          missingFields: ["cuit"],
          ownerPrompt:
            "Para emitir facturas necesito tu CUIT — ¿me lo compartís?",
        }
      : { blocked: false, missingFields: [], ownerPrompt: "" },
  };
}

// ---------------------------------------------------------------------------
// LLM-prompt helper
// ---------------------------------------------------------------------------

/**
 * Returns a compact Spanish paragraph listing all blocked capabilities,
 * suitable for injecting into a Supervisor or Companion prompt.
 * Returns null when nothing is missing.
 */
export function summarizeMissingData(result: MissingBusinessData): string | null {
  const blockedPrompts = (
    Object.values(result) as CapabilityStatus[]
  )
    .filter((c) => c.blocked)
    .map((c) => c.ownerPrompt);

  if (blockedPrompts.length === 0) return null;

  const intro =
    "Hay datos del negocio que todavía no están configurados y bloquean algunas funciones:";
  const items = blockedPrompts.map((p) => `• ${p}`).join("\n");
  return `${intro} ${items}`;
}
