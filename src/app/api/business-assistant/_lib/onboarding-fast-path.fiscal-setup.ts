// Fiscal-setup mini-flow — post-onboarding, 3-step conversational sequence.
// Fires when the owner expresses an invoice/comprobante intent and Business.cuit is null.
// Does NOT touch the main onboarding state machine (T1-T9) — fully additive.
//
// Steps:
//   FS1  ask CUIT   — free text, validated with the AFIP check-digit algorithm
//   FS2  ask IVA condition — chips: Monotributista / Responsable Inscripto / Exento
//   FS3  ask punto de venta — numeric string (or "más tarde" to defer)
//
// Each step persists via update_business_setup actions (same as onboarding).
// All parsers are pure — no DB reads, no side effects.

import { parseCuit } from "@/lib/cuit";
import { normalizeForMatching } from "@/lib/normalize";
import {
  buildFS1Result,
  buildFS1ValidationError,
  buildFS2Result,
  buildFS3Result,
  buildFS3DeferResult,
  buildFSPrompt,
} from "./onboarding-fast-path.fiscal-setup.builders";

export type { FiscalSetupResult } from "./onboarding-fast-path.fiscal-setup.builders";

// ── State ─────────────────────────────────────────────────────────────────────

export interface FiscalSetupState {
  /** True when Business.cuit has been set (11-digit string). */
  cuitSet: boolean;
  /** True when Business.ivaCondition has been set. */
  ivaConditionSet: boolean;
  /** True when Business.puntoVenta has been set (or deferred). */
  puntoVentaSet: boolean;
}

/** Pending step: 1=CUIT, 2=IVA condition, 3=punto de venta, null=complete. */
function pendingStep(state: FiscalSetupState): 1 | 2 | 3 | null {
  if (!state.cuitSet) return 1;
  if (!state.ivaConditionSet) return 2;
  if (!state.puntoVentaSet) return 3;
  return null;
}

// ── Parsers ───────────────────────────────────────────────────────────────────

/**
 * Accepts 11 raw digits or XX-XXXXXXXX-X format.
 * Returns the normalized 11-digit string on success, or null on format failure.
 * Uses the AFIP check-digit algorithm from src/lib/cuit.ts.
 */
export function parseFiscalCuit(text: string): { cuit: string } | { error: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Only accept inputs that look like a CUIT: 11 digits or XX-XXXXXXXX-X.
  const cleaned = trimmed.replace(/\D/g, "");
  if (cleaned.length !== 11) return null;
  // If raw text has non-CUIT characters beyond dashes (e.g. words), reject.
  if (/[a-zA-Z]/.test(trimmed)) return null;
  const result = parseCuit(trimmed);
  if (!result.valid) return { error: result.error ?? "CUIT inválido" };
  return { cuit: result.normalized };
}

// ── IVA condition ─────────────────────────────────────────────────────────────

export type IvaCondition = "Monotributista" | "Responsable Inscripto" | "Exento";
export const IVA_CONDITION_ALLOWLIST: ReadonlySet<IvaCondition> = new Set([
  "Monotributista",
  "Responsable Inscripto",
  "Exento",
]);

/** All valid IVA conditions for a *customer* — superset of the business list.
 *  Customers can be Consumidor Final; businesses cannot. Shared so the
 *  customer schema and the fiscal-setup flow stay in sync. */
export const CUSTOMER_IVA_CONDITIONS = [
  "Monotributista",
  "Responsable Inscripto",
  "Exento",
  "Consumidor Final",
] as const;
export type CustomerIvaCondition = (typeof CUSTOMER_IVA_CONDITIONS)[number];

const IVA_ALIASES: Record<string, IvaCondition> = {
  "monotributista": "Monotributista",
  "monotributo": "Monotributista",
  "mono": "Monotributista",
  "responsable inscripto": "Responsable Inscripto",
  "responsableinscripto": "Responsable Inscripto",
  "ri": "Responsable Inscripto",
  "resp inscripto": "Responsable Inscripto",
  "exento": "Exento",
  "exenta": "Exento",
};

export function parseFiscalIvaCondition(text: string): IvaCondition | null {
  const normalized = normalizeForMatching(text).trim();
  if (!normalized) return null;
  const direct = IVA_ALIASES[normalized];
  if (direct) return direct;
  // Substring scan for chip values (e.g. "soy monotributista").
  for (const [alias, value] of Object.entries(IVA_ALIASES)) {
    if (normalized.includes(alias)) return value;
  }
  return null;
}

// ── Punto de venta ────────────────────────────────────────────────────────────

const DEFER_PATTERNS = new Set([
  "mas tarde", "más tarde", "despues", "después", "ahora no", "omitir",
  "saltear", "skip",
]);

// Sale verbs and product words that signal the message is a different intent,
// not a punto-de-venta answer. Used to guard against numeric hijack mid-flow.
const SALE_INTENT_RE =
  /\b(vend[eé]|cobr[aá]|registr[aá]|anot[aá]|hac[eé]|pone[s]?|tir[aá]|quiero|mand[aá]|factur[aá])\b/i;

/**
 * Returns a punto de venta string (1-4 digit numeric string with leading zeros
 * stripped, e.g. "1", "10", "1001") or "defer" when the owner wants to skip.
 * Returns null when the input doesn't match.
 *
 * Strict guard: rejects messages that contain sale verbs or extra non-label
 * words so a mid-flow "vendé 5 tuercas" does not capture "5" as PV.
 * Only accepts: a bare number, or a number preceded/followed by a short
 * label like "punto de venta" / "PV" / "pv".
 */
export function parseFiscalPuntoVenta(text: string): string | "defer" | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const normalized = normalizeForMatching(trimmed);
  if (DEFER_PATTERNS.has(normalized)) return "defer";

  // Reject immediately if the message looks like a different intent.
  if (SALE_INTENT_RE.test(trimmed)) return null;

  // Only accept inputs whose non-label, non-numeric payload is empty.
  // Strip optional "punto de venta" / "pv" / "p.v." label around the digits.
  const stripped = trimmed
    .replace(/punto\s+de\s+venta/i, "")
    .replace(/\bp\.?\s*v\.?\b/i, "")
    .trim();

  if (/^\d{1,4}$/.test(stripped)) {
    const num = Number(stripped);
    if (num >= 1 && num <= 9999) return String(num);
  }
  return null;
}

// ── State machine entry point ─────────────────────────────────────────────────

/**
 * Entry point. Returns a FiscalSetupResult if the owner's input fits the
 * current pending step; null if input is out-of-vocabulary (falls through to LLM).
 *
 * Does NOT throw: ambiguous / out-of-vocabulary input returns null.
 */
export function detectFiscalSetupFastPath(
  text: string,
  state: FiscalSetupState,
): import("./onboarding-fast-path.fiscal-setup.builders").FiscalSetupResult | null {
  if (typeof text !== "string") return null;
  const step = pendingStep(state);
  if (step === null) return null;

  switch (step) {
    case 1: {
      const cuitResult = parseFiscalCuit(text);
      if (cuitResult === null) return null;
      if ("error" in cuitResult) return buildFS1ValidationError(cuitResult.error);
      return buildFS1Result(cuitResult.cuit);
    }
    case 2: {
      const iva = parseFiscalIvaCondition(text);
      if (!iva) return null;
      return buildFS2Result(iva);
    }
    case 3: {
      const pv = parseFiscalPuntoVenta(text);
      if (!pv) return null;
      return pv === "defer" ? buildFS3DeferResult() : buildFS3Result(pv);
    }
  }
}

/**
 * Returns the prompt to show the owner when the fiscal-setup flow is triggered
 * for the first time (CUIT not yet captured). This is the FS0 "gate" message.
 */
export function buildFiscalSetupGatePrompt(): import("./onboarding-fast-path.fiscal-setup.builders").FiscalSetupResult {
  return buildFSPrompt();
}
