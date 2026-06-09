// Onboarding Fast Path — patrón Fast/Slow Path canónico Velora.
// (ver memoria `feedback_deterministic_before_llm.md`)
//
// Onboarding v3 (2026-06-04): 2-turn LLM-fronted chat onboarding.
// El resto del setup vive en el SetupChecklist del dashboard (Part B).
// Pattern: Stripe Incremental Onboarding (currently_due + progressive disclosure) +
// NN/g contextual-help-over-front-loaded-tutorials.
//   https://docs.stripe.com/connect/custom/hosted-onboarding
//   https://www.nngroup.com/articles/onboarding-tutorials/
//
// Turnos activos en el flow lineal:
//   T1  nombre del negocio — string corto no vacío (o chip "Omitir")
//   T5  oferta de catálogo — chips (planilla/foto/pegar) o "No tengo todavía" (skip)
//       → gate releases → owner opera; servicios (MP/AFIP/Andreani/WhatsApp) en la tarjeta.
//
// Turnos disponibles vía NLU/JIT (no emitidos por detectPendingTurn en el
// flow lineal — switch cases retenidos para el path de fallback/LLM):
//   T3 métodos de pago, T8 alias/CBU, T9 CP, T10 courier,
//   T11 WhatsApp, T12 clientes, T13 ARCA, T14 Andreani.
//
// El detector NO escribe a la DB — devuelve un FastPathResult con la acción
// correspondiente. El caller persiste vía las acciones del handler.
// Eso mantiene una sola ruta de persistencia + invalidación de cache, y este
// módulo queda testeable sin Prisma.

import {
  detectBusinessTypeChange,
  detectPaymentMethods,
  detectCourierChoice,
  detectWhatsappPhone,
  detectPostalCode,
  detectTCustomersChoice,
  detectConnectChoice,
} from "./onboarding-fast-path.parsers";
import {
  parseSingleCustomerInput,
  parseBulkCustomerInput,
} from "./onboarding-fast-path.parsers.t-customers";
import { parseBulkProductInput } from "./onboarding-fast-path.bulk-parser";
import {
  buildBulkProductInputResult,
  buildT1FromText,
  buildT1SkipResult,
  buildT2UpdateResult,
  buildT3Result,
  buildT3bDispatch,
  buildT4CpResult,
  buildT5CourierResult,
  buildT6WaPrompt,
  buildT6WaPhoneResult,
  buildT6WaDeferResult,
  buildTCustomersResult,
  buildTCustomersInlineResult,
  buildTArcaResult,
  buildTArcaCuitReceivedResult,
  buildTAndreaniResult,
  buildTAndreaniTokenReceivedResult,
} from "./onboarding-fast-path.builders";
import {
  buildT3CatalogArchivoResult,
  buildT3CatalogFotoResult,
  buildT3CatalogPegarResult,
  buildT3CatalogSkipResult,
  buildT3CatalogPrompt,
} from "./onboarding-fast-path.builders.t3catalog";
import { detectCuit } from "./onboarding-fast-path.parsers.t-arca-cuit";
import { detectAndreaniToken } from "./onboarding-fast-path.parsers.t-andreani-token";
import { encryptCredential } from "@/lib/credential-cipher";
import type { OnboardingFastPathState } from "./onboarding-fast-path.state";

export type { FastPathResult } from "./onboarding-fast-path.builders";
export type { OnboardingFastPathState } from "./onboarding-fast-path.state";

/**
 * Próximo turno pendiente del onboarding o null si está completo.
 *
 * Sequence (v3 2026-06-04):
 *   1 → business name (free text, or "Omitir" chip)
 *   5 → catalog offer (chips, or "No tengo todavía" → skippedCatalog)
 *   null → gate released — owner operates immediately; services go to the card.
 *
 * The remaining turns (3,8,9,10,11,12,13,14) are available JIT via NLU
 * but NOT emitted by this function in the linear flow anymore.
 * The switch cases below are retained for NLU/JIT fallback paths and future
 * reactivation.
 */
export function detectPendingTurn(
  state: OnboardingFastPathState,
): 1 | 2 | 3 | 4 | 5 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | null {
  // Onboarding v3 (2026-06-04): two turns — name (1) then catalog offer (5) —
  // then release. Services (payment/shipping/WhatsApp/AFIP) live in the
  // SetupChecklist card, not chat. See file header for sourced rationale.
  if (!state.businessNameSet) return 1;
  if (state.productCount === 0 && !state.skippedCatalog) return 5;
  return null;
}

/**
 * Punto de entrada. Devuelve un FastPathResult si la respuesta del dueño cae
 * dentro del vocabulario conocido del turno actual; null si hay que ir al LLM.
 *
 * No tira: cualquier input ambiguo / fuera de vocabulario devuelve null.
 */
export function detectOnboardingFastPath(
  text: string,
  state: OnboardingFastPathState,
): import("./onboarding-fast-path.builders").FastPathResult | null {
  if (typeof text !== "string") return null;
  const turn = detectPendingTurn(state);
  if (turn === null) return null;

  // T2 update guard (JIT only): when businessType is set and the owner sends a
  // known business-type name or "change type to X" phrase while a JIT turn is
  // pending (turn > 2), treat it as a T2 update.
  // In the v3 linear flow, detectPendingTurn only returns 1 | 5 | null, so this
  // guard fires exclusively in JIT/NLU paths where the caller overrides the turn.
  // Exceptions: turn 5 (catalog) — product names/lists must not be mistaken for type aliases.
  //             turn 10 (courier) — "otro"/"ninguno" could be courier intent.
  //             turn 11 (WA phone input) — short strings may be mistaken for type aliases.
  //             turns 12-14 — connect/defer/skip chips should not be mistaken for type aliases.
  if (state.businessTypeSet && turn > 2 && turn !== 5 && turn !== 10 && turn !== 11 && turn !== 12 && turn !== 13 && turn !== 14) {
    const updatedType = detectBusinessTypeChange(text);
    if (updatedType) return buildT2UpdateResult(updatedType);
  }

  // No deterministic help-word interception here. Parsers below validate the
  // SHAPE of the data (so "ayudame" is never persisted as an alias). When a
  // parser rejects an input the switch returns null and the supervisor LLM
  // takes over with the welcome + turn context — that is the design per the
  // 2026 dialogue-management research (Detect-Explain-Escalate). The
  // deterministic turn re-prompt only fires as the catch-all when the
  // supervisor itself fails (see supervisor-runner.ts).

  switch (turn) {
    case 1: {
      // "Omitir" chip — owner skips the name step; placeholder applied.
      const norm1 = text.trim().toLowerCase();
      if (norm1 === "omitir" || norm1 === "omitir nombre" || norm1 === "saltar") {
        return buildT1SkipResult();
      }
      return buildT1FromText(text);
    }
    // ── JIT/NLU cases — detectPendingTurn does NOT emit these in the linear flow ──
    // These cases are retained so that if the owner triggers a JIT intent via chat
    // (e.g., "quiero conectar Mercado Pago") the Supervisor can delegate here.
    // They also serve as fallback paths if detectPendingTurn is overridden externally.
    // To reactivate any turn in the linear flow, add it back to detectPendingTurn.
    case 3: {
      // JIT: payment methods (MP, Transferencia, Efectivo)
      const methods = detectPaymentMethods(text);
      return methods ? buildT3Result(methods) : null;
    }
    // Pass mercadoPagoSelected so buildT3bResult can fire open_mp_oauth inline,
    // collapsing T7 into the alias sub-turn when both Transferencia + MP are selected.
    case 8: return buildT3bDispatch(text, state.mercadoPagoSelected); // JIT: transfer alias/CBU
    case 9: {
      // JIT: postal code
      const cp = detectPostalCode(text);
      return cp ? buildT4CpResult(cp) : null;
    }
    case 10: {
      // JIT: courier preference
      const courier = detectCourierChoice(text);
      return courier ? buildT5CourierResult(courier) : null;
    }
    case 11: {
      // T6 WhatsApp — chip "wa_defer" | "Más tarde" | free text "más tarde" → defer
      const norm = text.trim().toLowerCase();
      if (norm === "wa_defer" || norm === "más tarde" || norm === "mas tarde") {
        return buildT6WaDeferResult();
      }
      // chip "wa_now" → prompt for the number
      if (norm === "wa_now" || norm === "ingresarlo ahora") {
        return buildT6WaPrompt();
      }
      // free-text number input (from the prompt in buildT6WaPrompt)
      const phone = detectWhatsappPhone(text);
      if (phone) return buildT6WaPhoneResult(phone);
      return null;
    }
    case 5: {
      // JIT: catalog import (archivo | foto | pegar | skip_catalogo).
      const norm = text.trim().toLowerCase();
      if (norm === "archivo" || norm === "subí tu planilla" || norm === "subi tu planilla") {
        return buildT3CatalogArchivoResult();
      }
      if (norm === "foto" || norm === "foto del catálogo" || norm === "foto del catalogo") {
        return buildT3CatalogFotoResult();
      }
      if (norm === "pegar" || norm === "pegá tu lista" || norm === "pega tu lista") {
        return buildT3CatalogPegarResult();
      }
      if (norm === "skip_catalogo" || norm === "no tengo todavía" || norm === "no tengo todavia" || norm === "no tengo") {
        return buildT3CatalogSkipResult();
      }
      // Bulk import: multi-line/semicolon list pasted directly (bypasses chip).
      const bulkResult = parseBulkProductInput(text);
      if (bulkResult) return buildBulkProductInputResult(bulkResult.products, bulkResult.skipped);
      // No recognized chip/paste → prompt catalog chips (LLM handles free-text).
      return null;
    }
    // case 6 (stock loop) removed from linear flow — bulk import creates with stock=0.
    // The loop is still callable post-onboarding via the NLU stock-adjust path.
    case 4: {
      // T4: guided first-sale prompt (aha moment). The fast-path returns null here
      // so the OnboardingAgent LLM generates the prompt with the actual product name
      // injected. The agent also persists firstSalePromptShown=true via action.
      // detectOnboardingFastPath returning null → agent takes over → correct.
      return null;
    }
    case 12: {
      // JIT: customers (foto / cargar manual / archivo / saltar).
      const choice = detectTCustomersChoice(text);
      if (choice) return buildTCustomersResult(choice);
      // Inline customer text — bulk paste (2+ lines) or single entry.
      const bulk = parseBulkCustomerInput(text);
      if (bulk) return buildTCustomersInlineResult(bulk.customers, bulk.skipped);
      const single = parseSingleCustomerInput(text);
      if (single) return buildTCustomersInlineResult([single], 0);
      return null;
    }
    case 13: {
      // JIT: ARCA/AFIP BYOA — two sub-states.
      // Sub-state 1 — awaiting_cuit: owner opened AFIP portal, now pasting CUIT.
      if (state.arcaPendingStep === "awaiting_cuit") {
        const cuit = detectCuit(text);
        if (cuit) return buildTArcaCuitReceivedResult(cuit);
        // Not a CUIT shape — fall back to LLM so the owner gets guidance.
        return null;
      }
      // Sub-state 0 — normal: show connect/defer chips.
      const arcaChoice = detectConnectChoice(text);
      return arcaChoice ? buildTArcaResult(arcaChoice) : null;
    }
    case 14: {
      // JIT: Andreani BYOA — two sub-states.
      // Sub-state 1 — awaiting_token: owner opened Andreani Developers, pasting token.
      if (state.andreaniPendingStep === "awaiting_token") {
        const rawToken = detectAndreaniToken(text);
        if (rawToken) {
          // encryptCredential may throw if AUTH_SECRET is missing — let it propagate
          // so the caller's error boundary catches it rather than silently storing
          // a plaintext token.
          const encryptedToken = encryptCredential(rawToken);
          return buildTAndreaniTokenReceivedResult(encryptedToken, state.courierPreference);
        }
        // Not a token shape — fall back to LLM.
        return null;
      }
      // Sub-state 0 — normal: show connect/defer chips.
      const andreaniChoice = detectConnectChoice(text);
      return andreaniChoice ? buildTAndreaniResult(andreaniChoice, state.courierPreference) : null;
    }
  }
  // Exhaustiveness fallback — every turn returned by detectPendingTurn has a
  // case above. If detectPendingTurn ever returns a number not covered (e.g.
  // future turns added without updating the switch), fall through to null so
  // the supervisor LLM handles the text instead of crashing.
  return null;
}
