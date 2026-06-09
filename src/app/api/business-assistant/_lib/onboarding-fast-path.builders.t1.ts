// T1 builders — split from onboarding-fast-path.builders.ts to keep
// that barrel under the 300-LOC limit (Code Size Contract).

// ── Checklist intro ───────────────────────────────────────────────────────────
//
// Shown after the owner provides (or skips) the business name. Introduces
// the SetupChecklist dashboard card so the owner knows where to complete
// remaining setup at their own pace.
//
// Sources (all verified HTTP 200):
// - Stripe Incremental Onboarding (release gate after minimum first step):
//   https://docs.stripe.com/connect/custom/hosted-onboarding
// - NN/g progressive disclosure (surface tasks incrementally):
//   https://www.nngroup.com/articles/progressive-disclosure/
// - Shopify Setup Guide ("give merchants the option to complete later"):
//   https://shopify.dev/docs/apps/design/user-experience/onboarding
// - Google Dialogflow slot-filling (ask one slot, release gate):
//   https://cloud.google.com/dialogflow/cx/docs/concept/parameter

import type { FastPathResult } from "./onboarding-fast-path.builders";

export const CHECKLIST_INTRO =
  "Todo listo. Ya podés usar el chat, registrar ventas y manejar tu stock — todo desde acá.\n\n" +
  "Cuando quieras conectar WhatsApp, Mercado Pago, facturación con AFIP o envíos con Andreani, " +
  "encontrás los pasos en la tarjeta de configuración que aparece en tu panel. " +
  "Cada uno tarda menos de un minuto y te lo explico antes de arrancar.";

export function buildT1Result(name: string): FastPathResult {
  return {
    answer: `${name}, anotado.\n\n${CHECKLIST_INTRO}`,
    actions: [{
      intent: "update_business_setup",
      data: { field: "businessName", value: name },
      summary: "Nombre del negocio guardado",
    }],
    chips: null,
    matchedTurn: 1,
  };
}

// T1 skip result — owner tapped "Omitir" chip without providing a name.
// Sets a placeholder name so detectPendingTurn returns null and the gate
// releases immediately (businessNameSet becomes true).
//
// Source: Shopify "Give merchants the option to complete later":
//   https://shopify.dev/docs/apps/design/user-experience/onboarding
export function buildT1SkipResult(): FastPathResult {
  return {
    answer: `Entendido.\n\n${CHECKLIST_INTRO}`,
    actions: [{
      intent: "update_business_setup",
      data: { field: "businessName", value: "Mi negocio" },
      summary: "Nombre omitido — placeholder aplicado",
    }],
    chips: null,
    matchedTurn: 1,
  };
}

// T1 prompt — fires when the owner sends a greeting/ack/blank/question that
// is not a real business name. Gentle re-ask, no persistence.
export function buildT1NamePrompt(): FastPathResult {
  return {
    answer: "¿Cómo se llama tu negocio?",
    actions: [],
    chips: null,
    matchedTurn: 1,
  };
}
