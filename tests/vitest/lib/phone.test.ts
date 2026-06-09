/**
 * Parity tests for src/lib/phone.ts (SLICE 5 — Unit B)
 *
 * Verifies that normalizePhoneE164() produces the SAME E.164 output as the old
 * custom normalizers for all AR inputs the app actually uses, so that stored
 * customer phone matching (Customer dedup) is not broken.
 *
 * The two "improvements" (cases where old returned null but new returns a valid
 * number) are documented explicitly — they are additive, not regressions.
 */

import { describe, it, expect } from "vitest";
import { normalizePhoneE164, normalizePhoneOrThrow } from "@/lib/phone";

// ── old normalizers reconstructed here for comparison ────────────────────────

/** Old normalizeArgPhone from sale-create-inline-customer-match.ts */
function oldNormalizeArgPhone(raw: string): string | null {
  const digits = raw.replace(/[\s-]/g, "").replace(/^\+/, "");
  if (!/^\d{8,15}$/.test(digits)) return null;
  if (digits.startsWith("549") && digits.length === 13) return `+${digits}`;
  if (digits.startsWith("54") && digits.length === 12) return `+549${digits.slice(2)}`;
  if (digits.startsWith("549") && digits.length > 13) return null;
  if (digits.startsWith("0") && digits.length === 11) return `+549${digits.slice(1)}`;
  if (digits.length === 10) return `+549${digits}`;
  return null;
}

/** Old normalizePhone from whatsapp-meta.ts (core logic, no cloudLog) */
function oldNormalizePhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  let result: string;
  if (digits.startsWith("54")) {
    result = digits[2] === "9" ? `+${digits}` : `+549${digits.slice(2)}`;
  } else if (!phone.trim().startsWith("+")) {
    result =
      digits.length === 11 && digits[0] === "9"
        ? `+54${digits}`
        : `+549${digits}`;
  } else {
    result = `+${digits}`;
  }
  const E164_REGEX = /^\+[1-9]\d{6,14}$/;
  if (!E164_REGEX.test(result)) return null;
  return result;
}

// ── parity table for normalizeArgPhone ───────────────────────────────────────

describe("normalizePhoneE164 — parity with old normalizeArgPhone", () => {
  const PARITY_CASES: [string, string | null][] = [
    // Already E.164 +549
    ["+5490000000000", "+5490000000000"],
    // +54 no 9 → insert 9
    ["+541100000000", "+5490000000000"],
    // 10-digit bare (Mendoza 261)
    ["1100000000", "+5490000000000"],
    // Buenos Aires 10-digit
    ["1112345678", "+5491112345678"],
    // Already +549 CABA
    ["+5491112345678", "+5491112345678"],
    // With spaces
    ["261 233 9930", "+5490000000000"],
    // With dashes
    ["261-233-9930", "+5490000000000"],
    // 0-prefix 11-digit
    ["01100000000", "+5490000000000"],
    // Short / invalid
    ["abc", null],
    ["123", null],
    // Buenos Aires 15-prefix (old national format)
    ["1512345678", "+5491512345678"],
  ];

  for (const [input, expected] of PARITY_CASES) {
    it(`"${input}" → ${expected}`, () => {
      expect(normalizePhoneE164(input)).toBe(expected);
    });
  }

  // Verify old normalizeArgPhone agrees for the parity table
  for (const [input, expected] of PARITY_CASES) {
    it(`old normalizeArgPhone("${input}") matches expected`, () => {
      expect(oldNormalizeArgPhone(input)).toBe(expected);
    });
  }
});

// ── cases where new behavior is an ADDITIVE improvement over old ─────────────

describe("normalizePhoneE164 — additive improvements (old returned null)", () => {
  it("91100000000 (11-digit local with 9 prefix) — old null, new +5490000000000", () => {
    // Old normalizeArgPhone rejected this (no matching branch).
    // normalizePhoneE164 correctly identifies it as a valid AR mobile.
    // Stored customer phones are always +549..., so this is new-input improvement only.
    expect(oldNormalizeArgPhone("91100000000")).toBe(null);
    expect(normalizePhoneE164("91100000000")).toBe("+5490000000000");
  });

  it("+5511912345678 (Brazil) — old null, new passes through as-is", () => {
    expect(oldNormalizeArgPhone("+5511912345678")).toBe(null);
    expect(normalizePhoneE164("+5511912345678")).toBe("+5511912345678");
  });
});

// ── parity table for normalizePhone (whatsapp-meta.ts) ───────────────────────

describe("normalizePhoneE164 — parity with old normalizePhone (whatsapp-meta)", () => {
  const WHATSAPP_PARITY_CASES: [string, string | null][] = [
    ["+5490000000000", "+5490000000000"],
    ["+541100000000", "+5490000000000"],
    ["1100000000", "+5490000000000"],
    ["91100000000", "+5490000000000"],
    ["1112345678", "+5491112345678"],
    ["+5491112345678", "+5491112345678"],
    ["261 233 9930", "+5490000000000"],
    ["261-233-9930", "+5490000000000"],
    ["+15551234567", "+15551234567"],
    ["+5511912345678", "+5511912345678"],
    ["1512345678", "+5491512345678"],
  ];

  for (const [input, expected] of WHATSAPP_PARITY_CASES) {
    it(`"${input}" → ${expected}`, () => {
      expect(normalizePhoneE164(input)).toBe(expected);
    });
  }

  // Verify old normalizePhone agrees for these cases
  for (const [input, expected] of WHATSAPP_PARITY_CASES) {
    it(`old normalizePhone("${input}") matches expected`, () => {
      expect(oldNormalizePhone(input)).toBe(expected);
    });
  }

  it("01100000000 — old produced wrong +54901100000000 (bug), new produces +5490000000000", () => {
    // Old: digits='01100000000', no leading '54', no '+' prefix → '+549' + '01100000000' = wrong
    // New: libphonenumber correctly parses 0261... as Argentine Mendoza → +5490000000000
    // This is a BUGFIX, not a regression. Stored phones are never in 02... format.
    expect(oldNormalizePhone("01100000000")).toBe("+54901100000000"); // documents the old bug
    expect(normalizePhoneE164("01100000000")).toBe("+5490000000000"); // correct
  });
});

// ── normalizePhoneOrThrow ────────────────────────────────────────────────────

describe("normalizePhoneOrThrow", () => {
  it("returns valid E.164 for recognized input", () => {
    expect(normalizePhoneOrThrow("1100000000")).toBe("+5490000000000");
  });

  it("throws for empty input", () => {
    expect(() => normalizePhoneOrThrow("")).toThrow();
  });

  it("throws for non-phone input", () => {
    expect(() => normalizePhoneOrThrow("abc")).toThrow();
  });
});
