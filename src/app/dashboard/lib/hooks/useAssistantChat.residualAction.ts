// Detects when a user message contained two intents joined by " y " /
// "tambien" / etc. and the command layer only handled the first. Used by
// useAssistantChat.ts after a successful command dispatch to surface a
// transient hint instead of silently dropping the second action.
//
// The Velora chat does NOT execute compound actions client-side; multi-
// intent inputs only go through compound dispatch when the AI route is
// reached. When the command layer matches the first intent it returns
// early before AI sees the input — the second intent is lost. Rather than
// silently dropping it, surface a one-message hint asking the user to
// re-send the second part separately.

import { tLang } from "../DashboardLangContext";
import type { AssistantIntent } from "@/app/api/business-assistant/_lib/types";
import { IMPERATIVE_TAIL_VERBS_RE } from "../command-parsers/shared";

// Friendly Spanish label per intent. Falls back to a generic phrase when
// an intent isn't mapped. New intents added to the union should also be
// mapped here, but the fallback ensures no crash.
function getIntentLabel(intent: string): string {
  const labels: Partial<Record<string, [string, string]>> = {
    register_sale: ["the sale", "la venta"],
    register_movement: ["the cash movement", "el movimiento de caja"],
    stock_load: ["the stock load", "la carga de stock"],
    stock_adjustment: ["the stock adjustment", "el ajuste de stock"],
    adjust_stock: ["the stock adjustment", "el ajuste de stock"],
    edit_product: ["the product edit", "la edición del producto"],
    delete_product: ["the product removal", "la baja del producto"],
    bulk_price_update: ["the price update", "la actualización de precios"],
    create_supplier: ["the supplier creation", "la creación del proveedor"],
    edit_supplier: ["the supplier edit", "la edición del proveedor"],
    delete_supplier: ["the supplier removal", "la baja del proveedor"],
    create_customer: ["the customer creation", "la creación del cliente"],
    edit_customer: ["the customer edit", "la edición del cliente"],
    delete_customer: ["the customer removal", "la baja del cliente"],
    business_query: ["the query", "la consulta"],
    check_stock: ["the stock query", "la consulta de stock"],
  };
  const pair = labels[intent];
  return pair ? tLang(pair[0], pair[1]) : tLang("your first action", "tu primera acción");
}

// Conjunctions where a second intent might begin. " y " is the dominant
// pattern; comma is too ambiguous (used inside multi-item lists). The
// other words are explicit sequence markers.
const RESIDUAL_SPLIT_RE = /\s+(?:y|tambien|también|despues|después|luego|además|ademas)\s+/i;

// First-token patterns that look like another action verb at the start of
// the residual tail. Anchored at start so we don't match verbs that
// appear later in a noun phrase. List is wide enough to catch the main
// action verbs across the union but kept conservative to avoid flagging
// continuations of the first intent (e.g. "vendí 2 peras y 3 sandías"
// where the residual starts with a number, not a verb).
const TAIL_VERB_RE = new RegExp(
  "^(?:" +
    [
      "vend\\w*",                    // vender / vendí / vendele
      "cobr\\w*",                    // cobrar / cobré
      "facturá?",                    // facturá / factura
      "carg[aá]\\w*",                // cargá / cargame
      "ingres[aá]\\w*",              // ingresá
      "me\\s+lleg\\w+",              // me llegaron
      "lleg\\w+",                    // llegaron
      "entr[oó]",                    // entró / entro
      "repuse",
      "recib[ií]\\w*",
      "ped[ií]\\w*",
      "trajer\\w*",
      "descont[aáée]\\w*",           // descontá / desconté
      "sumal?[eé]\\w*",              // sumale
      "agregal?[eé]\\w*",            // agregale
      "ajust[aá]\\w*",
      "dej[aá]\\w*",
      "pon[eé]l?[aoe]?\\w*",         // poné / ponele
      "borr[aá]\\w*",
      "elimin[aá]\\w*",
      "quit[aá]\\w*",
      "sac[aá]\\w*",
      "remov[aáée]\\w*",
      "dar\\s+de\\s+baja",
      "actualiz[aá]\\w*",
      "cambi[aá]\\w*",
      "sub[ií]\\w*",
      "aument[aá]\\w*",
      "baj[aá]\\w*",
      "reduc\\w*",
      "pag[uúéeo]\\w*",
      "gast[éeo]\\w*",
      "compr[ée]\\w*",
      "registr[aá]\\w*",
      "anot[aá]\\w*",
      "cre[aá]\\w*",
      "agreg[aá]\\w*",
      "guard[aá]\\w*",
    ].join("|") +
  ")(?![a-z\u00E1\u00E9\u00ED\u00F3\u00FA\u00F1])",
  "i",
);

/**
 * If the user's message contained " y "/"tambien"/etc. followed by what
 * looks like another action, return a Spanish hint message. Otherwise
 * return null. Caller is responsible for actually appending the message
 * to chat as transient.
 */
export function buildResidualActionWarning(
  rawText: string,
  matchedIntent: AssistantIntent | string,
): string | null {
  const firstLabel = getIntentLabel(matchedIntent);

  // Pass 1: explicit conjunction split (" y ", "tambien", "luego", etc.).
  const split = rawText.split(RESIDUAL_SPLIT_RE);
  if (split.length >= 2) {
    const tail = split.slice(1).join(" ").trim();
    if (tail && TAIL_VERB_RE.test(tail)) {
      return tLang(`Processed ${firstLabel}. For "${tail}", send me a new message.`, `Procesé ${firstLabel}. Para "${tail}", mandame un mensaje nuevo.`);
    }
  }

  // Pass 2: imperative tail without an explicit conjunction
  // (e.g. "vendí 3 a Carlos mándale whatsapp"). The customer-name slot
  // already swallowed the name; the imperative onward is the residual.
  const impMatch = rawText.match(IMPERATIVE_TAIL_VERBS_RE);
  if (impMatch && impMatch.index !== undefined) {
    const tail = rawText.slice(impMatch.index).trim();
    if (tail) {
      return tLang(`Processed ${firstLabel}. For "${tail}", send me a new message.`, `Procesé ${firstLabel}. Para "${tail}", mandame un mensaje nuevo.`);
    }
  }

  return null;
}
