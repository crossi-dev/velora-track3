// UI label builder for stock shortfall warnings.
//
// Renders the banner text shown below a flagged line item on the sale draft
// card when the requested quantity exceeds available stock. Detection logic
// lives in @/domain/rules (detectStockShortfall).

import type { detectStockShortfall } from "@/domain/rules";
import { tLang } from "./DashboardLangContext";

type StockShortfall = NonNullable<ReturnType<typeof detectStockShortfall>>;

// Banner text shown under the line item. Spanish, short, explicit.
export function buildStockShortfallLabel(s: StockShortfall): string {
  const noun = s.available === 1 ? tLang("unit", "unidad") : tLang("units", "unidades");
  if (s.available <= 0) {
    return tLang(`⚠ Out of stock (requested ${s.requested}, available 0)`, `⚠ Sin stock (pedís ${s.requested}, hay 0)`);
  }
  return tLang(`⚠ Low stock — ${s.available} ${noun} available`, `⚠ Stock bajo — ${s.available} ${noun} disponibles`);
}
