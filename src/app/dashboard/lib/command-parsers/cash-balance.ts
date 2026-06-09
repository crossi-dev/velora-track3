import type { VeloraSingleCommand } from "./shared";

const CASH_BALANCE_PATTERNS: RegExp[] = [
  /\bcuanto\s+(?:hay|tengo|queda|tenemos)(?:\s+en\s+caja)?\b/,
  /\bcuanta\s+plata\s+(?:hay|tengo|queda|tenemos)\b/,
  /\bsaldo\s+(?:de|en)\s+(?:la\s+)?caja\b/,
  /^saldo\s*\??$/,
  /^(?:como\s+)?(?:esta|anda|va)\s+(?:la\s+)?caja\b/,
  /^caja(?:\s+actual)?\s*\??$/,
  /\btotal\s+(?:de\s+|en\s+)?caja\b/,
];

export function detectCashBalance(normalized: string): VeloraSingleCommand | null {
  for (const pattern of CASH_BALANCE_PATTERNS) {
    if (pattern.test(normalized)) {
      return { matched: true, intent: "cash_balance", data: {} };
    }
  }
  return null;
}
