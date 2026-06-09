// Deterministic re-prompt builder for the current onboarding turn.
//
// Used as the LAST-RESORT catch-all: when the supervisor LLM crashes or
// returns null during onboarding, this gives the owner a visible exit
// (the turn's question + its chips) instead of a dead string.
//
// Confusion-handling design (2026-05-24, validated against Detect-Explain-
// Escalate research + Google ADK conventions):
//   - Parsers validate slot data shape (so "ayudame" is NEVER persisted as
//     an alias). On invalid input, the fast path returns null.
//   - When the fast path returns null, the SUPERVISOR LLM receives the
//     owner's text + onboarding context and replies conversationally.
//   - If the supervisor itself fails, THIS builder fires as the catch-all.
//
// `isHelpOrConfusion` is no longer consulted here — the supervisor decides
// whether the input is confusion. This builder is invoked solely when the
// supervisor cannot respond at all.

import { T3_CHIPS, T3_CATALOG_CHIPS, T5_COURIER_CHIPS, T6_WA_CHIPS } from "./onboarding-fast-path.chips";
import { isHelpOrConfusion } from "./onboarding-help-words";
import {
  type FastPathResult,
  buildT1Prompt,
  buildT1Result,
  buildT3bResult,
} from "./onboarding-fast-path.builders";
import { looksLikeBusinessNameInput, isLikelyChipResponseNotName, detectTransferAlias, looksLikeSiArrancamosChip, looksLikeContameMasChip } from "./onboarding-fast-path.parsers";
import { buildT6Prompt } from "./onboarding-fast-path.builders.t5t6";
import {
  buildTCustomersPrompt,
  buildTArcaPrompt,
  buildTAndreaniPrompt,
} from "./onboarding-fast-path.builders.t12t14";

// T3b prompt — gives a concrete example of the expected shape so the owner
// knows what to type. Replaces the previous fallback (return null → LLM)
// that silently swallowed help words as data.
export function buildT3bPrompt(): FastPathResult {
  return {
    answer:
      "Para transferencias necesito tu alias bancario (ej: `mi.negocio.mp`, " +
      "siempre con puntos) o un CBU de 22 dígitos. ¿Cuál es el tuyo?",
    actions: [],
    chips: null,
    matchedTurn: 8,
  };
}

// T3b dispatcher — case 8 entry point.
// Returns a FastPathResult ONLY when the input is a well-formed alias
// (dot-separated word.word.word) or a 22-digit CBU. Anything else
// (help words, invalid format, free text) returns null so the supervisor
// LLM responds conversationally with welcome context + the alias prompt.
export function buildT3bDispatch(text: string, mercadoPagoSelected?: boolean): FastPathResult | null {
  if (isHelpOrConfusion(text)) return null;
  const alias = detectTransferAlias(text);
  return alias ? buildT3bResult(alias, mercadoPagoSelected) : null;
}

// T1 dispatcher — case 1 entry point.
// Three deterministic paths + everything else falls to the supervisor LLM:
//   - Real business name      → buildT1Result (save + advance to T3)
//   - Chip "Contame más"      → buildT1Prompt(text) routes to the explainer
//   - Chip "Sí, arrancamos"   → buildT1Prompt(text) → warm name prompt
//   - Anything else           → null (LLM handles, e.g. "no entiendo")
//
// Free-text confusion is intentionally routed to the supervisor: enumerating
// every Spanish help phrase ("no entiendo", "no sé", "me perdi", "qué hago",
// "ayudame", ...) into a deterministic script doesn't scale. Gemini Pro reads
// the welcome context + the owner's words and replies conversationally.
export function buildT1FromText(text: string): FastPathResult | null {
  const name = looksLikeBusinessNameInput(text);
  if (name) return buildT1Result(name);
  // isLikelyChipResponseNotName is true whenever looksLikeBusinessNameInput
  // returns null — that covers greetings, affirmations ("Sí, arrancamos"),
  // info-request chips ("Contame más"), blank inputs, and questions. We only
  // produce a deterministic re-prompt for the two welcome chips; everything
  // else falls through to the supervisor LLM so it can respond conversationally.
  if (isLikelyChipResponseNotName(text) && (looksLikeContameMasChip(text) || looksLikeSiArrancamosChip(text))) {
    return buildT1Prompt(text);
  }
  return null;
}

// Unconditional turn re-prompt — used as the OnboardingAgent failure
// catch-all. Returns the deterministic question + chips for the current
// turn, regardless of input content. Unlike buildHelpFallback this does
// NOT consult isHelpOrConfusion — it fires when the agent itself broke
// (timeout / parse / validation), so the owner gets a useful exit even
// when they sent a perfectly normal message.
export function buildOnboardingTurnPrompt(
  turn: number,
  courierPreference: string | null,
  pendingStockProductName: string | null,
): FastPathResult {
  switch (turn) {
    case 1: return { answer: "¿Cómo se llama tu negocio?", actions: [], chips: null, matchedTurn: 1 };
    case 3: return { answer: "¿Cómo cobrás? Tocá los que uses (Efectivo, Mercado Pago, Tarjeta, Transferencia) y dale a Listo.", actions: [], chips: T3_CHIPS, matchedTurn: 3 };
    case 8: return buildT3bPrompt();
    case 9: return { answer: "¿Cuál es el código postal de tu negocio? (4 o 5 dígitos, por ejemplo `5500`)", actions: [], chips: null, matchedTurn: 9 };
    case 10: return { answer: "¿Con qué correo hacés envíos? Tocá una opción.", actions: [], chips: T5_COURIER_CHIPS, matchedTurn: 10 };
    case 11: return { answer: "¿Cuál es el WhatsApp del negocio? Decime el número o tocá 'Más tarde'.", actions: [], chips: T6_WA_CHIPS, matchedTurn: 11 };
    case 5: return { answer: "Cargá tu catálogo. ¿Cómo querés hacerlo?", actions: [], chips: T3_CATALOG_CHIPS, matchedTurn: 5 };
    case 4: return {
      answer: "Listo, el negocio está armado.\n\nProbemos. Decime tu primera venta:\n• Simple: \"vendí 1 alfajor 500 efectivo\"\n• Completa: \"vendí 1 alfajor a Juan Pérez 11 1234 5678 envío a Belgrano por transferencia\" — dispara venta + cliente + comprobante + envío en un mensaje.",
      actions: [{
        intent: "update_business_setup",
        data: { field: "firstSalePromptShown", value: true },
        summary: "Prompt de primera venta mostrado (T4)",
      }],
      chips: null,
      matchedTurn: 4,
    };
    case 7: return buildT6Prompt();
    case 12: return buildTCustomersPrompt();
    case 13: return buildTArcaPrompt();
    case 14: return buildTAndreaniPrompt(courierPreference);
    default: return { answer: "Sigamos con tu configuración. ¿Te puedo ayudar con algo?", actions: [], chips: null, matchedTurn: 1 };
  }
}

export function buildHelpFallback(
  text: string,
  turn: number,
  courierPreference: string | null,
): FastPathResult | null {
  // Turn 1 (name): free-text confusion ("no entiendo", "me perdi") goes to
  // the supervisor LLM. The welcome message is conversational, not a data
  // capture — Gemini Pro reads the welcome + the owner's words and replies
  // with empathy. Chip taps ("Sí, arrancamos" / "Contame más") are handled
  // deterministically by buildT1FromText, not by this fallback.
  if (turn === 1) return null;
  // Turn 6 (stock loop): "no se" maps to quantity=0, must not be intercepted.
  if (turn === 6) return null;
  if (!isHelpOrConfusion(text)) return null;
  switch (turn) {
    case 3: return {
      answer: "Para los cobros, tocá los que uses (Efectivo, Mercado Pago, Tarjeta, Transferencia) y dale a Listo.",
      actions: [], chips: T3_CHIPS, matchedTurn: 3,
    };
    case 8: return buildT3bPrompt();
    case 9: return {
      answer: "Necesito el código postal de tu negocio (4 o 5 dígitos), por ejemplo `5500`.",
      actions: [], chips: null, matchedTurn: 9,
    };
    case 10: return {
      answer: "¿Con qué correo hacés envíos? Tocá una opción.",
      actions: [], chips: T5_COURIER_CHIPS, matchedTurn: 10,
    };
    case 11: return {
      answer: "¿Cuál es el WhatsApp del negocio? Lo uso para enviarte avisos. Decime el número o tocá 'Más tarde'.",
      actions: [], chips: T6_WA_CHIPS, matchedTurn: 11,
    };
    case 5: return {
      answer: "Para cargar el catálogo, tocá una opción: planilla, foto, pegar la lista, o saltear por ahora.",
      actions: [], chips: T3_CATALOG_CHIPS, matchedTurn: 5,
    };
    case 7: return buildT6Prompt();
    case 12: return buildTCustomersPrompt();
    case 13: return buildTArcaPrompt();
    case 14: return buildTAndreaniPrompt(courierPreference);
    default: return null;
  }
}
