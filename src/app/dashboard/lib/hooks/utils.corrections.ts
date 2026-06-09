"use client";

import { normalizeLookupText } from "../helpers";
import type { ParsedSale } from "../types";

export function looksLikeParsedSaleCorrection(text: string) {
  const normalized = normalizeLookupText(text).replace(/[.!?,;:]+$/g, "").trim();
  if (!normalized) return false;

  // If the text contains an explicit sale verb, the user is starting a new sale,
  // not correcting the current draft — let it fall through to the assistant.
  const hasSaleVerb = /\b(vendi|vendo|vend[eio]|cobr[ae]|registr[ae]|factur[ae])\b/.test(normalized);
  if (hasSaleVerb) return false;

  const correctionPatterns = [
    /^(?:no|nop|correccion|corrección)\b/,
    /\b(?:era|eran|es para|es de|mejor dicho|quise decir)\b/,
    /\b(?:cambia|cambiar|corregi|corregir|ajusta|ajustar|suma|sumale|resta|restale|agrega|agregale|quita|quitar)\b/,
    /\b(?:cliente|producto|precio|cantidad|unidades?)\b/,
    /^\d+\b/,
  ];

  return correctionPatterns.some((pattern) => pattern.test(normalized));
}

export function mergeParsedSaleCorrection(baseSaleText: string, correctionText: string) {
  const base = baseSaleText.trim();
  const correction = correctionText.trim();
  if (!base) return correction;
  if (!correction) return base;

  return `${base}. ${correction}`;
}

export function buildEditableSaleText(sale: ParsedSale) {
  const itemText = (sale.items ?? [])
    .map((item) => `${item.quantity} ${item.productName}`)
    .join(", ");

  if (sale.customer?.name && itemText) {
    return `${itemText} a ${sale.customer.name}`;
  }

  return itemText || sale.customer?.name || "";
}
