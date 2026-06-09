import { type SiteLocale } from "@/lib/site-locale";
import { normalizePersonOrBusinessName, normalizeForMatching } from "./normalize";

export { normalizePersonOrBusinessName };

// Delegates to canonical normalizeForMatching (NFKC\u2192NFD\u2192\p{M} strip \u2014 wider
// than the old [\u0300-\u036f] range, also covers Cyrillic homoglyphs via NFKC).
// Dedup 2026-05-29 \u2014 3 private copies consolidated to canonical.
export function normalizeLookupText(value: string): string {
  return normalizeForMatching(value.trim());
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

export function buildCustomerFullName(firstName: string, lastName: string) {
  const merged = `${firstName.trim()} ${lastName.trim()}`.trim();
  return normalizePersonOrBusinessName(merged);
}

export function translateBusinessType(type: string, locale: SiteLocale) {
  const labels: Record<string, string> = {
    "Auto Parts": "Repuestos",
    Retail: "Comercio",
    Hardware: "Ferretería",
    "Food & Drink": "Gastronomía",
    Services: "Servicios",
    Other: "Otro",
  };

  void locale;
  return labels[type] ?? type;
}
