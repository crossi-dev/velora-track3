// Parser for T12 (customers) onboarding turn.
// Pure — no context reads, no DB writes.

import { normalizeForMatching } from "@/lib/normalize";

export type TCustomersChoice = "foto" | "manual" | "archivo" | "saltar";

export interface ParsedCustomerInput {
  name: string;
  whatsapp: string | null;
}

const FOTO_VALUES = new Set([
  "customers_foto",
  "foto del cuaderno",
  "foto",
]);

const MANUAL_VALUES = new Set([
  "customers_manual",
  "cargar manual",
  "manual",
  "a mano",
  "tipear",
]);

const ARCHIVO_VALUES = new Set([
  "customers_archivo",
  "subir excel o csv",
  "subir excel",
  "subir csv",
  "excel",
  "csv",
  "planilla",
  "archivo",
]);

const SALTAR_VALUES = new Set([
  "customers_saltar",
  "saltar por ahora",
  "saltar",
  "saltear",
  "mas tarde",
  "despues",
  "no por ahora",
  "skip",
]);

export function detectTCustomersChoice(text: string): TCustomersChoice | null {
  const normalized = normalizeForMatching(text).trim();
  if (!normalized) return null;
  if (FOTO_VALUES.has(normalized)) return "foto";
  if (MANUAL_VALUES.has(normalized)) return "manual";
  if (ARCHIVO_VALUES.has(normalized)) return "archivo";
  if (SALTAR_VALUES.has(normalized)) return "saltar";
  // Partial match for archivo variants
  if (/excel|csv|planilla/.test(normalized)) return "archivo";
  // Partial match for foto
  if (/\bfoto\b|\bcuaderno\b/.test(normalized)) return "foto";
  return null;
}

// Argentine phone normalization patterns:
//   "11 1234 5678"  → "1112345678"
//   "+5491112345678" → "1112345678"
//   "011 1234-5678" → "1112345678"
//   "1100000000"    → "1100000000" (already clean)
function normalizeArgentinePhone(raw: string): string | null {
  // Strip everything except digits and leading +
  const digits = raw.replace(/[^\d]/g, "");
  // Argentina: +54 9 {area}{number} or just {area}{number}
  // Strip country code 54 if present (15 digits: 54 + 9 + 10 or 54 + 10)
  if (digits.startsWith("549") && digits.length >= 12) return digits.slice(3);
  if (digits.startsWith("54") && digits.length >= 11) return digits.slice(2);
  // Strip leading 0 for Buenos Aires legacy format (011...)
  if (digits.startsWith("0") && digits.length >= 10) return digits.slice(1);
  // Accept 10-digit numbers as-is
  if (digits.length >= 10) return digits.slice(0, 15);
  return null;
}

// Detects a phone number token in a string.
// Returns the normalized phone or null if none found.
function extractPhoneFromText(text: string): string | null {
  // Match sequences that look like phone numbers (at least 8 consecutive digits,
  // possibly broken by spaces, dashes, parens, or a leading +)
  const phoneRegex = /(\+?\d[\d\s\-().]{7,20}\d)/g;
  const matches = text.match(phoneRegex);
  if (!matches) return null;
  for (const m of matches) {
    const normalized = normalizeArgentinePhone(m.trim());
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Parses a single line of customer text: "Nombre [WhatsApp]".
 * WhatsApp is optional. Returns null if the name cannot be determined.
 *
 * Accepted formats:
 *   "María López"
 *   "María López 1112345678"
 *   "María López +5491112345678"
 *   "María López 11 1234 5678"
 */
export function parseSingleCustomerInput(line: string): ParsedCustomerInput | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const phone = extractPhoneFromText(trimmed);
  // Remove the phone part from the name
  const nameRaw = phone
    ? trimmed.replace(/\+?\d[\d\s\-().]{7,20}\d/, "").trim()
    : trimmed;

  const name = nameRaw.replace(/\s+/g, " ").trim();
  // Name must have at least 2 characters (avoid single letters being names)
  if (name.length < 2) return null;
  // Reject lines that look like they are headers or numeric-only
  if (/^\d+$/.test(name)) return null;

  return { name, whatsapp: phone };
}

/**
 * Parses one or more lines of customer text (bulk paste).
 * Returns an array of parsed customers (empty if nothing parses).
 * Skipped lines (unparseable) are counted in `skipped`.
 */
export function parseBulkCustomerInput(
  text: string,
): { customers: ParsedCustomerInput[]; skipped: number } | null {
  // Split by newline or semicolon
  const lines = text.split(/[\n;]+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null; // single line → use parseSingleCustomerInput

  const customers: ParsedCustomerInput[] = [];
  let skipped = 0;
  for (const line of lines) {
    const parsed = parseSingleCustomerInput(line);
    if (parsed) {
      customers.push(parsed);
    } else {
      skipped++;
    }
  }
  if (customers.length === 0) return null;
  return { customers, skipped };
}
