// Inline new-customer detection helpers — extracted from sale-create-fast-path.ts
// to keep that file under the 300-line server/api limit.
//
// These utilities handle the "a/para [Name] [phone]" pattern that appears when
// the owner registers a sale for a customer not yet in the catalog. The detector
// in sale-create-fast-path.ts imports these to avoid duplicating the phone
// normalization logic.

import { normalizePhoneE164 } from "@/lib/phone";

// Returned when product resolves AND text contains "a/para [Name] [phone]"
// but name doesn't match any existing customer. The dispatcher creates the
// customer inline (upsert by phone) and registers the sale atomically.
// Phone is always normalized to +549XXXXXXXXXX (Argentine mobile E.164).
export interface SaleCreateInlineNewCustomerMatch {
  kind: "inline_new_customer";
  matchedProductId: string;
  productName: string;
  qty: number;
  unitPrice: number | null;
  newCustomerName: string;
  newCustomerPhone: string; // normalized +549XXXXXXXXXX
}

// Matches "a Carlos Rossi 1100000000", "a maría garcia 1100000000",
// "a Carlos, +5490000000000", "a Juan Pérez tel 261 233 9930".
//
// Relaxations vs. original:
//   - Name words accept \p{L}+ (lowercase ok) instead of requiring \p{Lu} start.
//   - Optional comma between name and phone (common STT + fast-typer output).
//   - Optional separator word "tel" / "cel" / "tlf" between name and phone.
//   - Phone pattern unchanged: 10–15 raw digit chars with optional spaces/dashes.
//
// Captured groups: [1]=name, [2]=raw phone token.
export const INLINE_CUSTOMER_RE =
  /\b(?:a|para)\s+([\p{L}][\p{L}]+(?:\s+[\p{L}][\p{L}]+){0,3})\s*,?\s*(?:tel|cel|tlf)?\s*(\+?[\d][\d\s-]{8,14}[\d])\b/u;

/**
 * Normalizes a raw Argentine phone string to +549XXXXXXXXXX (E.164 mobile).
 *
 * Delegates to normalizePhoneE164 from @/lib/phone (libphonenumber-js backed).
 * Output is byte-identical to the old custom normalizer for all AR inputs stored
 * in the Customer table — see tests/vitest/lib/phone.test.ts for the parity table.
 *
 * Source: https://github.com/catamphetamine/libphonenumber-js
 */
export function normalizeArgPhone(raw: string): string | null {
  return normalizePhoneE164(raw);
}

/**
 * Attempts to parse "a/para [Name] [phone]" from raw sale text.
 * Returns the inline match if a valid name+phone is found; null otherwise.
 * Checks the catalog for existing customers by phone to avoid duplicates —
 * if a phone match is found, caller should reuse the existing customer.
 *
 * @param text - Original (not normalized) sale text.
 * @param catalogCustomers - Current business customer catalog entries.
 */
export function detectInlineNewCustomer(
  text: string,
  catalogCustomers: Array<{ id: string; name: string; phone?: string }>,
): { kind: "reuse_existing"; customerId: string; customerName: string } | SaleCreateInlineNewCustomerMatch | null {
  const inlineMatch = INLINE_CUSTOMER_RE.exec(text);
  if (!inlineMatch) return null;

  const rawName = inlineMatch[1].trim();
  const rawPhone = inlineMatch[2].trim();
  const normalizedPhone = normalizeArgPhone(rawPhone);
  if (normalizedPhone === null) return null;

  // Check catalog for existing customer with same phone to avoid duplicate.
  const existingByPhone = catalogCustomers.find(
    (c) => typeof c.phone === "string" && normalizeArgPhone(c.phone) === normalizedPhone,
  );
  if (existingByPhone) {
    return { kind: "reuse_existing", customerId: existingByPhone.id, customerName: existingByPhone.name };
  }

  return {
    kind: "inline_new_customer",
    // matchedProductId filled by caller (has product context)
    matchedProductId: "",
    productName: "",
    qty: 1,
    unitPrice: null,
    newCustomerName: rawName,
    newCustomerPhone: normalizedPhone,
  };
}
