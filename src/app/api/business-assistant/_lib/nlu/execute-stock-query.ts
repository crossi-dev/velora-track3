// Executor for the stock_query Fast Path. Read-only — no RBAC gate
// (lectura del catálogo no es destructiva, ambos roles pueden), no
// idempotency contract, no audit event. Pure function over the
// already-detected intent + dispatcher params.
//
// Resolution: reuse `findProductInfoMatch` from the inventory handlers
// so fuzzy/SKU/quoted matching stays identical to the LLM path. On
// miss we answer deterministically — still no LLM call. The Slow Path
// is reserved for everything that isn't "stock of one specific product".

import { NextResponse } from "next/server";
import { findProductInfoMatch } from "../handlers/inventory-matching";
import { buildProductStockAnswer, buildInventorySummaryAnswer } from "../handlers/inventory-responses";
import type { StockQueryIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

export function executeStockQuery(
  intent: StockQueryIntent,
  params: PreModelIntentParams,
): NextResponse {
  const { match, ambiguous } = findProductInfoMatch(
    intent.productText,
    params.productInfoDirectory,
  );

  // Employee onboarding-task tracking removed (0 rows in production, Stage 1 cleanup).

  if (ambiguous) {
    return NextResponse.json({
      answer: `Encontré varios productos parecidos a "${intent.productText}". Decime cuál es.`,
      inputHint: "Ej: cuánto stock tengo de Filtro Bosch",
    });
  }

  if (!match) {
    return NextResponse.json({
      answer: `No encontré "${intent.productText}" en tu catálogo.`,
    });
  }

  return NextResponse.json({
    answer: buildProductStockAnswer(match, params.locale),
  });
}

// Executor for the stock_summary Fast Path — general "¿cuánto stock tengo?"
// without a specific product. Bypasses the Supervisor LLM which misreads
// "stock" as a product name. Uses the same buildInventorySummaryAnswer as
// the business-query post-handler but fires BEFORE the LLM call.
export function executeStockSummary(params: PreModelIntentParams): NextResponse {
  const { context, business, locale } = params;
  const products = context.products ?? params.productInfoDirectory.map((p) => ({
    name: p.name,
    price: p.price,
    stock: p.stock,
  }));
  const answer = buildInventorySummaryAnswer(
    { business, inventorySummary: context.inventorySummary, products },
    locale,
  );
  return NextResponse.json({ answer, actions: [] });
}
