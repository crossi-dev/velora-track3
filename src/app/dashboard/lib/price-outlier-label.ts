// UI label builder for price outlier warnings.
//
// Renders the banner text shown below a flagged line item on the sale draft
// card. Currency is formatted in es-AR for consistency with the rest of the
// UI. Detection logic lives in @/domain/rules (detectPriceOutlier).

import type { detectPriceOutlier } from "@/domain/rules";
import { tLang } from "./DashboardLangContext";

type PriceOutlier = NonNullable<ReturnType<typeof detectPriceOutlier>>;

// Builds the banner text rendered below the flagged line item.
export function buildPriceOutlierLabel(
  outlier: PriceOutlier,
  currency: string,
): string {
  const fmt = new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: currency || "ARS",
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  const arrow = outlier.direction === "above" ? "↑" : "↓";
  return tLang(`⚠ Price ${arrow} — catalog: ${fmt.format(outlier.expected)}`, `⚠ Precio ${arrow} — catálogo: ${fmt.format(outlier.expected)}`);
}
