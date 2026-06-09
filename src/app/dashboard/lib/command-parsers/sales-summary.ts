import type { SalesSummaryData, SalesSummaryPeriod, VeloraSingleCommand } from "./shared";
import { parseRelativeDateAR } from "../../../../lib/parse-relative-date";

// Matches every common Spanish phrasing of "sales total over a period":
//   - verb forms: cuánto vendí / facturé / cobré / entré / ingresé
//   - "ventas de hoy / ayer / esta semana / este mes"
//   - "resumen de ventas"
//   - "cómo fueron/venimos/vamos/va/anda(n) las ventas" or bare
//     "cómo venimos" / "cómo vamos" (implicit sales context)
//   - "total de ventas"
const SALES_SUMMARY_VERB_RE =
  /\b(?:cuanto|cuantas?|cuantos?)\s+(?:vendi|facture|cobre|entre|ingrese|venta)|ventas?\s+(?:de|del)|resumen\s+(?:de\s+)?ventas?|\bcomo\s+(?:venimos|vamos)\b|\bcomo\s+(?:fueron|va|anda|estan|van)(?:\s+(?:las?\s+)?ventas?|\s+(?:hoy|ayer|esta\s+semana|este\s+mes))\b|\btotal\s+(?:de\s+|en\s+)?ventas?\b/;

/**
 * Fast-path 4-bucket detector. Returns null on miss so the caller can
 * fall through to the chrono-based slow path.
 */
function detectPeriodFast(normalized: string): SalesSummaryPeriod | null {
  if (/\bayer\b/.test(normalized)) return "yesterday";
  if (/\b(?:esta\s+semana|semanal|semana)\b/.test(normalized)) return "week";
  if (/\b(?:este\s+mes|mensual|mes)\b/.test(normalized)) return "month";
  if (/\bhoy\b/.test(normalized)) return "today";
  return null;
}

/**
 * Detects the period from the normalised input. First tries the fast
 * literal-match 4-bucket path; on miss falls through to `parseRelativeDateAR`
 * (chrono-node ES + AR-specific patterns). Defaults to "today" only when
 * neither path finds a date expression.
 */
function detectPeriodData(normalized: string): SalesSummaryData {
  const fast = detectPeriodFast(normalized);
  if (fast !== null) {
    return { period: fast };
  }

  const parsed = parseRelativeDateAR(normalized);
  if (parsed !== null) {
    return {
      period: parsed.label,
      customRange: { startMs: parsed.startMs, endMs: parsed.endMs },
    };
  }

  // Default: no recognisable period → assume today.
  return { period: "today" };
}

export function detectSalesSummary(normalized: string): VeloraSingleCommand | null {
  if (!SALES_SUMMARY_VERB_RE.test(normalized)) return null;
  return {
    matched: true,
    intent: "sales_summary",
    data: detectPeriodData(normalized),
  };
}
