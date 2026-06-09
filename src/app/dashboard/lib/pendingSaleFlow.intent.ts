"use client";

import { normalizeLookupText } from "../../../lib/shared-utils";
import type { PendingSaleFlow, PendingSaleMissingField } from "./pendingSaleFlow.types";
import { defaultPendingSaleInputHint } from "./pendingSaleFlow.transitions";

function hasSaleIntent(text: string) {
  const normalized = normalizeLookupText(text);
  return /\b(vendi|vendo|vender|venta|ventas|cobrar|cobro|facturar|factura|registrar)\b/.test(normalized);
}

function hasClarificationTone(answer: string) {
  const normalized = normalizeLookupText(answer);
  return (
    answer.includes("?") ||
    /\b(necesito|falta|decime|deci|indicame|indica|cual|cuanto|cuanta|cuantos|cuantas|quien|cliente|precio|cantidad|unidades)\b/.test(normalized)
  );
}

function inferMissingField(answer: string, saleText: string): PendingSaleMissingField | null {
  const normalizedAnswer = normalizeLookupText(answer);
  if (!normalizedAnswer) return null;

  if (/\b(cliente|nombre completo|a quien|quien|quien es)\b/.test(normalizedAnswer)) {
    return "customer";
  }

  if (/\b(a cuanto|precio|valor|cuesta|sale a|costo|pesos|ars|cobraste|cobras)\b/.test(normalizedAnswer)) {
    return "price";
  }

  if (/\b(cantidad|cuanto|cuanta|cuantos|cuantas|unidad|unidades)\b/.test(normalizedAnswer)) {
    return "quantity";
  }

  return !/\d/.test(saleText) ? "quantity" : null;
}

export function inferPendingSaleFlow(text: string, answer: string, inputHint?: string | null): PendingSaleFlow | null {
  // If Gemini 2.5 Flash (Companion) asks a clarification AND (text has sale verb OR text has numbers + product-like words)
  if (!hasClarificationTone(answer)) return null;
  const hasNumbers = /\d/.test(text) || /\b(un|una|dos|tres|cuatro|cinco)\b/i.test(text);
  if (!hasSaleIntent(text) && !hasNumbers) return null;

  const missingField = inferMissingField(answer, text);
  if (!missingField) return null;

  return {
    saleText: text,
    missingField,
    answer,
    inputHint: inputHint?.trim() || defaultPendingSaleInputHint(missingField),
  };
}

/**
 * Returns true if the text looks like a brand-new sale request rather than
 * a reply to a pending clarification question (price, quantity, customer).
 *
 * A short reply (under 5 words without sale-intent verbs) is assumed to be
 * answering the pending question. A longer message that starts with or
 * contains a sale-intent verb is treated as a new sale — the caller should
 * clear the pending flow and let the message reach Gemini 2.5 Flash (Companion).
 */
export function looksLikeNewSaleIntent(text: string): boolean {
  const normalized = normalizeLookupText(text);
  if (!normalized) return false;

  const tokens = normalized.split(/\s+/);

  // Question words — if the sentence is a question about sales, not a sale command
  const questionPattern = /\b(cuanto|cuantos|cuantas|cuanta|como|que|cual|cuales|cuando|donde|por que|quien)\b/;
  if (questionPattern.test(normalized)) return false;

  // Sale-intent verbs in Argentine Spanish
  const saleVerbs = /\b(vendi|vendo|vender|vendele|vendemos|venta|cobrale|cobra|cobrar|cobro|registra|registrar|factura|facturar|emiti|emitir)\b/;
  const hasSaleVerb = saleVerbs.test(normalized);

  // Short replies without sale verbs are answers to the pending question
  if (tokens.length < 5 && !hasSaleVerb) return false;

  // If it has a sale verb, it's a new sale intent
  return hasSaleVerb;
}

export function isSaleFlowCancelCommand(text: string) {
  const normalized = normalizeLookupText(text).replace(/[.!?,;:]+$/g, "").trim();
  return [
    "cancelar",
    "cancela",
    "cancela la venta",
    "cancelar la venta",
    "descartar",
    "descarta",
    "descartar venta",
    "cancelar borrador",
    "cancelar borrador de venta",
    "salir",
    "olvidalo",
    "olvidate",
    "olvida",
    "no importa",
    "deja",
    "dejalo",
    "dejala",
    "nada",
    "no nada",
    "no gracias",
    "no quiero",
    "borralo",
    "borrar",
    "no no",
    "ya fue",
    "ya esta",
    "listo",
    "dejar",
  ].includes(normalized);
}
