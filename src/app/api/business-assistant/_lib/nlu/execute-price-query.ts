// Executor for the price_query Fast Path.
// Read-only — no RBAC gate (reading price/stock is not destructive),
// no idempotency contract, no audit event.
//
// Resolution reuses findProductInfoMatch for fuzzy/SKU/quoted matching
// identical to the LLM path. On miss we answer deterministically — no
// LLM call needed.
//
// Role-agnostic: both owner and employee contexts are supported.
// Guard: currency falls back to "ARS" if the context field is empty or
// missing (prevents Intl.NumberFormat RangeError in edge contexts).

import { NextResponse } from "next/server";
import { findProductInfoMatch } from "../handlers/inventory-matching";
import { buildProductStockAnswer } from "../handlers/inventory-responses";
import { formatMoney } from "../shared";
import type { PriceQueryIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

export function executePriceQuery(
  intent: PriceQueryIntent,
  params: PreModelIntentParams,
): NextResponse {
  // Null-safe: prefer params.business.currency, fall back through
  // context.business.currency, then hard-default to "ARS".
  // Intl.NumberFormat throws RangeError on empty-string currency.
  const currency =
    params.business?.currency ||
    params.context?.business?.currency ||
    "ARS";

  let match, ambiguous;
  try {
    ({ match, ambiguous } = findProductInfoMatch(
      intent.productText,
      params.productInfoDirectory ?? [],
    ));
  } catch {
    return NextResponse.json({
      answer: `No pude buscar "${intent.productText}" en el catálogo. Intentá de nuevo.`,
    });
  }

  if (ambiguous) {
    return NextResponse.json({
      answer: `Encontré varios productos parecidos a "${intent.productText}". ¿Cuál es?`,
      inputHint: "Ej: cuánto sale Coca Cola 500ml",
    });
  }

  if (!match) {
    return NextResponse.json({
      answer: `No encontré "${intent.productText}" en el catálogo.`,
    });
  }

  if (intent.queryKind === "price") {
    return NextResponse.json({
      answer: `${match.name} vale ${formatMoney(match.price, currency, params.locale ?? "")}.`,
    });
  }

  return NextResponse.json({
    answer: buildProductStockAnswer(match, params.locale ?? ""),
  });
}
