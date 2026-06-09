"use client";

import { normalizePersonOrBusinessName } from "../../../../lib/normalize";

export { normalizePersonOrBusinessName };

export function buildCustomerFullName(firstName: string, lastName: string) {
  const f = firstName.trim();
  const l = lastName.trim();
  if (f && l) return `${f} ${l}`;
  return f || l || "";
}

export function splitCustomerName(value: string) {
  const normalized = normalizePersonOrBusinessName(value);
  if (!normalized) return { firstName: "", lastName: "" };
  const [firstName = "", ...rest] = normalized.split(/\s+/).filter(Boolean);
  return {
    firstName,
    lastName: rest.join(" "),
  };
}

export function cleanDisplayInput(text: string): string {
  let s = text.trim();
  if (!s) return s;
  // Fix common missing accents
  s = s
    .replace(/\bcuantos\b/gi, "cuántos")
    .replace(/\bcuantas\b/gi, "cuántas")
    .replace(/\bcuanto\b/gi, "cuánto")
    .replace(/\bcuanta\b/gi, "cuánta")
    .replace(/\bque\b/g, "qué")
    .replace(/\bcomo\b/gi, "cómo")
    .replace(/\bdonde\b/gi, "dónde")
    .replace(/\bcuales\b/gi, "cuáles")
    .replace(/\bcual\b/gi, "cuál")
    .replace(/\bquienes\b/gi, "quiénes")
    .replace(/\bquien\b/gi, "quién")
    .replace(/\bcuando\b/gi, "cuándo")
    .replace(/\bmas\b/gi, "más")
    .replace(/\bvendi\b/gi, "vendí");
  // Capitalize first letter
  s = s.charAt(0).toUpperCase() + s.slice(1);
  // Add ¿…? if starts with a question word
  if (/^(cuánto|cuánta|cuántos|cuántas|qué|cómo|dónde|cuál|cuáles|quién|quiénes|cuándo|por qué)/i.test(s)) {
    if (!s.startsWith("¿")) s = "¿" + s;
    if (!s.endsWith("?")) s = s.replace(/[.,!]*$/, "") + "?";
  }
  return s;
}
