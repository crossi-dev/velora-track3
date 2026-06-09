// Constructores de FastPathResult para cada turno del onboarding.
// Separado de onboarding-fast-path.ts para mantener ese archivo bajo 300 LOC.
// Cada builder es puro — no lee contexto, no escribe DB.

import type { ChipsBundle } from "@/app/api/supervisor/_lib/supervisor-chips";
import type { SupervisorAction } from "@/app/api/supervisor/_lib/business-rule-actions";
import { T3_CHIPS, T3_CATALOG_CHIPS, T5_COURIER_CHIPS, T6_WA_CHIPS } from "./onboarding-fast-path.chips";
import { looksLikeContameMasChip } from "./onboarding-fast-path.parsers";
// T5 product/stock loop and T6 MP OAuth builders live in the .t5t6 sibling —
// re-exported here so existing importers need no changes.
export {
  buildBulkProductInputResult,
  buildT5ProductInputResult,
  buildT5Result,
  buildT5bResult,
  buildT5dContinueResult,
  buildT5dFinishResult,
  buildT6Prompt,
  buildT6ConnectResult,
  buildT6DeferResult,
} from "./onboarding-fast-path.builders.t5t6";

// T12 (customers), T13 (ARCA), T14 (Andreani) builders.
export {
  buildTCustomersResult,
  buildTCustomersPrompt,
  buildTCustomersInlineResult,
  buildTArcaResult,
  buildTArcaPrompt,
  buildTArcaCuitReceivedResult,
  buildTAndreaniResult,
  buildTAndreaniPrompt,
  buildTAndreaniTokenReceivedResult,
} from "./onboarding-fast-path.builders.t12t14";

// Help / confusion fallback dispatcher + T1/T3b dispatchers live in a sibling —
// re-export so onboarding-fast-path.ts can import everything from this barrel.
export {
  buildHelpFallback,
  buildT1FromText,
  buildT3bDispatch,
  buildT3bPrompt,
} from "./onboarding-fast-path.help-fallback";

// T1 builders (checklist-intro redesign 2026-05-29) live in a dedicated sibling
// to keep this barrel under 300 LOC (Code Size Contract).
export {
  buildT1Result,
  buildT1SkipResult,
  buildT1NamePrompt,
} from "./onboarding-fast-path.builders.t1";

export interface FastPathResult {
  /** Texto de respuesta que el cliente verá. */
  answer: string;
  /** Acción update_business_setup (T1-T4) o action client-side (T5/T6). */
  actions: SupervisorAction[];
  /** Chips del próximo turno (si corresponde). */
  chips: ChipsBundle | null;
  /** Client-side action. open_photo_picker/open_file_picker = onboarding pickers; open_mp_oauth = MP OAuth (web only); open_settings = settings panel; open_external_account = provider portal in new tab (BYOA — owner auths against AFIP/Andreani directly); open_paste_textarea = multi-line paste input for bulk product list. */
  clientAction?: "open_photo_picker" | "open_file_picker" | "open_mp_oauth" | "open_settings" | "open_external_account" | "open_paste_textarea";
  /** Params: panel (settings), context (photo target: products|customers), url+service (external account portal). */
  clientActionParams?: { panel?: string; context?: "products" | "customers"; url?: string; service?: string };
  /**
   * Cuál turno se resolvió — para tracing/observabilidad.
   * 4=T4 first-sale prompt; 5=catalog/bulk; 6=legacy stock (no lineal); 7=MP OAuth (no lineal).
   * 8=alias/CBU, 9=CP, 10=courier, 11=WA, 12=customers, 13=ARCA, 14=Andreani.
   */
  matchedTurn: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
}

// T1 explainer — fires when the owner taps the welcome chip "Contame más"
// (or types a variant like "explicame", "qué es Velora", etc.). Gives a
// concrete pain-+-example pitch and rolls into the name question so the next
// turn is still T1 with the real name. Deterministic — the LLM is not
// involved here; previously the LLM repeated the welcome blurb verbatim.
export function buildT1ContameMasResult(): FastPathResult {
  return {
    answer:
      "Te cuento. Hoy seguro coordinás todo a mano: vendés por WhatsApp, cobrás por Mercado Pago, facturás en ARCA, enviás por Andreani — son 4 apps abiertas y todas las idas y vueltas las hacés vos. Yo te las junto en un solo chat para que te enfoques en vender.\n\n" +
      "Un ejemplo concreto: el cliente te pide una caja de alfajores → te armo el link de pago de MP → cuando paga te aviso al toque → emito el comprobante automático → coordino el envío con Andreani → te aviso cuando llega al cliente. Vos solo charlás conmigo.\n\n" +
      "¿Arrancamos? Decime cómo se llama tu negocio.",
    actions: [],
    chips: null,
    matchedTurn: 1,
  };
}

// T1 dispatcher — single entry point for the "not a real name" branch. Picks
// the explainer for "Contame más" variants and the bare warm prompt for
// everything else (greetings, "Sí, arrancamos", blank, questions, etc.).
export function buildT1Prompt(text: string): FastPathResult {
  return looksLikeContameMasChip(text) ? buildT1ContameMasResult() : buildT1NamePromptLocal();
}

// Local alias to avoid importing from the t1 sibling just for this helper —
// the export is already re-exported above via the t1 barrel.
function buildT1NamePromptLocal(): FastPathResult {
  return {
    answer: "¿Cómo se llama tu negocio?",
    actions: [],
    chips: null,
    matchedTurn: 1,
  };
}

export function buildT2Result(type: string): FastPathResult {
  return {
    answer: "Anotado. ¿Cómo cobrás? Tocá los que uses y dale a Listo.",
    actions: [{
      intent: "update_business_setup",
      data: { field: "businessType", value: type },
      summary: "Tipo de negocio guardado",
    }],
    chips: T3_CHIPS,
    matchedTurn: 2,
  };
}

/** Cambio de tipo DESPUÉS de que T2 ya quedó resuelto. */
export function buildT2UpdateResult(type: string): FastPathResult {
  return {
    answer: `Cambié el tipo a ${type}. Avisame si querés ajustar algo más.`,
    actions: [{
      intent: "update_business_setup",
      data: { field: "businessType", value: type },
      summary: "Tipo de negocio actualizado",
    }],
    chips: null,
    matchedTurn: 2,
  };
}

export function buildT3Result(methods: string[]): FastPathResult {
  const hasTransfer = methods.includes("Transferencia");
  const hasMP = methods.includes("Mercado Pago");
  // MP OAuth collapses into T2: fire inline when MP selected and no alias step follows.
  // If Transferencia is also selected, the alias step (T8) comes first; MP OAuth fires
  // at the end of T8 via buildT3bResult so the owner isn't interrupted mid-setup.
  const triggerMpOauth = hasMP && !hasTransfer;
  const nextQuestion = hasTransfer
    ? "Perfecto. Para Transferencia decime tu alias o CBU."
    : hasMP
    ? "Anotado. Te conecto a Mercado Pago para que cobres con QR — autorizás en 10 segundos."
    : "¿Cuál es el código postal de tu negocio? (4 o 5 dígitos)";
  // When MP OAuth fires inline (MP selected, no Transferencia), pre-set the
  // deferred flag so that closing the OAuth window without completing does NOT
  // advance the flow past T3. The flag is cleared by the MP OAuth callback on
  // successful token exchange. Without this, an abandoned OAuth → flow skips
  // to T9 with no MpConnection and no re-prompt (silent dead end, 2026-05-25).
  const actions: FastPathResult["actions"] = [{
    intent: "update_business_setup",
    data: { field: "paymentMethods", value: methods },
    summary: "Métodos de pago guardados",
  }];
  if (triggerMpOauth) {
    actions.push({
      intent: "update_business_setup",
      data: { field: "mercadoPagoOnboardingDeferred", value: true },
      summary: "MP OAuth abierto — pendiente de completar",
    });
  }
  return {
    answer: `Anotado: ${methods.join(", ")}. ${nextQuestion}`,
    actions,
    chips: null,
    ...(triggerMpOauth ? { clientAction: "open_mp_oauth" as const } : {}),
    matchedTurn: 3,
  };
}

/** T3b: alias/CBU capturado. mercadoPagoSelected=true → fire open_mp_oauth inline (T7 colapsado). */
export function buildT3bResult(alias: string, mercadoPagoSelected?: boolean): FastPathResult {
  const hasMp = mercadoPagoSelected === true;
  const nextCopy = hasMp
    ? `Anotado el alias ${alias}. Te conecto a Mercado Pago ahora — autorizás en 10 segundos.`
    : `Anotado el alias ${alias}. ¿Cuál es el código postal de tu negocio? (4 o 5 dígitos)`;
  // Mirror T3 deferred-flag pattern: pre-set mercadoPagoOnboardingDeferred=true before
  // open_mp_oauth fires so that closing the OAuth window without completing does NOT
  // advance the flow past T3b. Flag cleared by MP OAuth callback on successful exchange.
  // Without this, abandoned OAuth on T3b path → same silent dead-end as was fixed in T3.
  const actions: FastPathResult["actions"] = [{
    intent: "update_business_setup",
    data: { field: "transferAlias", value: alias },
    summary: "Alias/CBU de transferencia guardado",
  }];
  if (hasMp) {
    actions.push({
      intent: "update_business_setup",
      data: { field: "mercadoPagoOnboardingDeferred", value: true },
      summary: "MP OAuth abierto — pendiente de completar",
    });
  }
  return {
    answer: nextCopy,
    actions,
    chips: null,
    ...(hasMp ? { clientAction: "open_mp_oauth" as const } : {}),
    matchedTurn: 8,
  };
}

/** T4: código postal del negocio capturado — avanza a courier. */
export function buildT4CpResult(postalCode: string): FastPathResult {
  return {
    answer: `CP ${postalCode}, anotado. ¿Con qué correo hacés envíos?`,
    actions: [{
      intent: "update_business_setup",
      data: { field: "postalCode", value: postalCode },
      summary: "Código postal guardado",
    }],
    chips: T5_COURIER_CHIPS,
    matchedTurn: 9,
  };
}

/** T5 (courier): preferencia de correo capturada — avanza a WhatsApp. */
export function buildT5CourierResult(courier: string): FastPathResult {
  const displayName = courier === "ninguno" ? "sin correo" : courier;
  return {
    answer: `${displayName === "sin correo" ? "Entendido, sin envíos por ahora." : `${courier} anotado.`} ¿Cuál es el WhatsApp del negocio? Lo uso para enviarte avisos.`,
    actions: [{
      intent: "update_business_setup",
      data: { field: "courierPreference", value: courier },
      summary: "Preferencia de correo guardada",
    }],
    chips: T6_WA_CHIPS,
    matchedTurn: 10,
  };
}

/** T6 (WhatsApp — ingresar ahora): el dueño ya envía el número en este mismo turno. */
export function buildT6WaPrompt(): FastPathResult {
  return {
    answer: "Decime el número de WhatsApp del negocio (10 dígitos, ej: 1100000000).",
    actions: [],
    chips: null,
    matchedTurn: 11,
  };
}

/** T6 (WhatsApp — número recibido): guardado. */
export function buildT6WaPhoneResult(phone: string): FastPathResult {
  return {
    answer: `WhatsApp +54${phone} guardado. Ahora cargamos tu catálogo. Elegí la forma que te queda cómoda:`,
    actions: [{
      intent: "update_business_setup",
      data: { field: "whatsappPhone", value: phone },
      summary: "WhatsApp del negocio guardado",
    }],
    chips: T3_CATALOG_CHIPS,
    matchedTurn: 11,
  };
}

/** T6 (WhatsApp — diferir): el dueño elige "Más tarde". */
export function buildT6WaDeferResult(): FastPathResult {
  return {
    answer: "Ok, lo configurás cuando quieras. Ahora cargamos tu catálogo. Elegí la forma que te queda cómoda:",
    actions: [{
      intent: "update_business_setup",
      data: { field: "whatsappPhone", value: "" },
      summary: "WhatsApp del negocio diferido",
    }],
    chips: T3_CATALOG_CHIPS,
    matchedTurn: 11,
  };
}


