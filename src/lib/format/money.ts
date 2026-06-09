/**
 * Currency-aware money formatter for customer-facing artifacts (PDFs, WhatsApp, summaries).
 * Single source of truth for all money formatting in Velora. Options cover the
 * three observed shapes: glyph-style (default for chips/PDFs), plain-ISO-prefix
 * (for compact summaries), and rounded-with-abs (for daily summaries).
 *
 * Also exports formatARS — canonical Argentine peso formatter with cents.
 * Bug fixed 2026-05-29: one copy in transfer-payment-request-wa.ts used
 * maximumFractionDigits:0 (dropped cents), diverging from all other callers.
 * Canonical: always show 2 decimal places ("$1.500,50"), matching payment-link
 * answer builder and PDF/WhatsApp receipt expectations.
 */

interface CurrencyProfile {
  glyph: string;
  locale: string;
}

const CURRENCY_MAP: Record<string, CurrencyProfile> = {
  ARS: { glyph: "$",   locale: "es-AR" },
  USD: { glyph: "US$", locale: "en-US" },
  BRL: { glyph: "R$",  locale: "pt-BR" },
};

export interface FormatMoneyOptions {
  /** Decimal places. Default 2. Use 0 for rounded totals (daily summaries). */
  decimals?: number;
  /** If true, always format `Math.abs(value)`. Default false. */
  absoluteValue?: boolean;
  /**
   * Output style:
   * - `glyph` (default): "$ 1.200,50" — uses CURRENCY_MAP glyph + locale.
   * - `iso-prefix`:      "ARS 1.200,50" — plain ISO code prefix, es-AR locale.
   * - `intl-currency`:   uses Intl.NumberFormat({ style: 'currency' }) — browser-default glyph + locale (es-AR).
   */
  style?: "glyph" | "iso-prefix" | "intl-currency";
}

/**
 * Format a monetary amount for a customer-facing artifact.
 *
 * @param value   Numeric amount.
 * @param currency ISO 4217 code (e.g. "ARS", "USD").
 * @param options Style + decimals overrides.
 * @returns       Formatted string. Examples:
 *   - default (glyph + 2 decimals): `"$ 1.200,50"` / `"US$ 1,200.50"`
 *   - style `iso-prefix`:           `"ARS 1.200,50"`
 *   - style `intl-currency` + decimals 0: `"$ 1.201"`
 */
export function formatMoney(
  value: number,
  currency: string,
  options: FormatMoneyOptions = {},
): string {
  const { decimals = 2, absoluteValue = false, style = "glyph" } = options;
  const num = absoluteValue ? Math.abs(value) : value;

  if (style === "intl-currency") {
    try {
      return new Intl.NumberFormat("es-AR", {
        style: "currency",
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }).format(num);
    } catch {
      // Intl throws on invalid currency code — fall back to glyph-less plain.
      return `$${Math.round(num).toLocaleString("es-AR")}`;
    }
  }

  if (style === "iso-prefix") {
    const formatted = Number(num).toLocaleString("es-AR", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return `${currency} ${formatted}`;
  }

  // Default: glyph style.
  const profile = CURRENCY_MAP[currency?.toUpperCase()];
  if (profile) {
    const formatted = Number(num).toLocaleString(profile.locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    return `${profile.glyph} ${formatted}`;
  }
  // Unknown code: ISO prefix + en-US formatting
  const formatted = Number(num).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  return `${currency ?? "?"} ${formatted}`;
}

/**
 * Format an Argentine peso amount with 2 decimal places.
 * Uses Intl.NumberFormat with style:"currency" so the output matches the
 * locale-standard ARS glyph ("$") and digit grouping ("1.500,50").
 *
 * Canonical — replaces 2 private copies that existed in:
 *   - nlu/payment-link-answer-builder.ts (correct, 2 decimals)
 *   - sales/create/_lib/transfer-payment-request-wa.ts (buggy, 0 decimals — BUG FIXED)
 *
 * @param amount  Numeric ARS amount.
 * @returns       e.g. "$1.500,50" for 1500.50
 */
export function formatARS(amount: number): string {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
