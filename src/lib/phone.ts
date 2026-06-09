/**
 * Shared phone normalization for Argentine and international numbers.
 *
 * Uses libphonenumber-js (maintained Google-libphonenumber port) for parsing
 * and validation, with a fallback for inputs the library cannot handle.
 *
 * Source: https://github.com/catamphetamine/libphonenumber-js
 * (VERIFIED HTTP 200, 2026-06-07)
 *
 * AR-specific: Argentine mobile numbers require a `9` after the `54` country
 * code in the WhatsApp/Meta API convention (+549XXXXXXXXXX). This is NOT
 * standard ITU E.164 (which would be +54XXXXXXXXXX), but it IS the format
 * stored in the Customer table and required by Meta Cloud API.
 * libphonenumber-js is used for parsing/validation; the `+549` assembly
 * happens in this module so the mobile-9 convention is applied consistently.
 *
 * Output parity tested against the old custom normalizers in:
 *   - src/app/api/business-assistant/_lib/nlu/sale-create-inline-customer-match.ts
 *   - src/lib/whatsapp-meta.ts
 * See tests/vitest/lib/phone.test.ts for the parity table.
 *
 * SCOPE: This module replaces the divergent CORE normalizers only.
 * Do NOT use it in src/app/api/business-assistant/_lib/onboarding-fast-path.parsers.t-customers.ts
 * (that file intentionally returns local bare-digit format, not E.164).
 */

import { parsePhoneNumberFromString } from "libphonenumber-js";

const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/**
 * Builds the AR E.164 mobile format (+549XXXXXXXXXX) from a libphonenumber
 * nationalNumber. libphonenumber keeps the mobile-9 in the nationalNumber for
 * already-normalized +549... inputs (nationalNumber = '9XXXXXXXXXX'), so we
 * strip the leading 9 before prepending +549 to avoid double-9.
 */
function buildArE164(nationalNumber: string): string {
  // nationalNumber is 10 or 11 digits. If 11 and starts with 9, strip the 9
  // (it's the mobile marker already included by libphonenumber).
  const nat =
    nationalNumber.length === 11 && nationalNumber.startsWith("9")
      ? nationalNumber.slice(1)
      : nationalNumber;
  return `+549${nat}`;
}

/**
 * normalizePhoneE164 converts an Argentine or international phone number to E.164.
 *
 * For Argentine numbers, output is always +549XXXXXXXXXX (mobile-9 convention
 * required by Meta Cloud API / WhatsApp). For non-AR international numbers,
 * returns the standard ITU E.164 from libphonenumber.
 *
 * Returns null for inputs that cannot be parsed or validated.
 * This is the "nullable" variant — callers that need to throw on failure should
 * wrap this in their own error handling (see normalizePhoneOrThrow).
 *
 * Replaces:
 *   normalizeArgPhone() in sale-create-inline-customer-match.ts
 *   The parsing core of normalizePhone() in whatsapp-meta.ts
 */
export function normalizePhoneE164(raw: string): string | null {
  if (!raw || !raw.trim()) return null;

  // Try libphonenumber first — default country AR so bare 10-digit numbers resolve.
  const parsed = parsePhoneNumberFromString(raw, "AR");
  if (parsed && parsed.isValid()) {
    if (parsed.country === "AR") {
      return buildArE164(parsed.nationalNumber);
    }
    // Non-AR international — return standard E.164
    return parsed.number;
  }

  // Fallback: manual heuristics for inputs libphonenumber can't classify.
  // Preserved from the old normalizeArgPhone to guarantee stored-phone
  // dedup parity for AR edge cases the library rejects.
  // For explicit + international numbers that parse as possible but not valid
  // (e.g. US 555 test numbers), pass through the digits with + prefix so the
  // behavior matches the old normalizePhone fallback path.
  const digits = raw.replace(/[\s\-().]/g, "").replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(digits)) return null;

  if (raw.trim().startsWith("+")) {
    // Already has explicit international prefix — pass through as E.164
    const candidate = `+${digits}`;
    if (E164_REGEX.test(candidate)) return candidate;
    return null;
  }

  if (digits.startsWith("549") && digits.length === 13) return `+${digits}`;
  if (digits.startsWith("54") && digits.length === 12) return `+549${digits.slice(2)}`;
  if (digits.startsWith("549") && digits.length > 13) return null; // ambiguous
  if (digits.startsWith("0") && digits.length === 11) return `+549${digits.slice(1)}`;
  if (digits.length === 10) return `+549${digits}`;

  return null;
}

/**
 * normalizePhoneOrThrow is the throwing variant used by the WhatsApp send path.
 * Matches the contract of the old normalizePhone() in whatsapp-meta.ts:
 *   - throws on invalid/empty input
 *   - validated against E.164 regex before returning
 *
 * Callers: whatsapp-meta.ts send functions.
 */
export function normalizePhoneOrThrow(raw: string): string {
  if (!raw || !raw.trim()) {
    throw new Error("El teléfono debe contener al menos un dígito.");
  }
  const result = normalizePhoneE164(raw);
  if (!result || !E164_REGEX.test(result)) {
    throw new Error(
      "El teléfono no tiene un formato E.164 válido. Verificá el número y volvé a intentarlo.",
    );
  }
  return result;
}
