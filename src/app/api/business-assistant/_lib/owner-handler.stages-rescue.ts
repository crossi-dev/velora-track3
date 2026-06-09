// owner-handler.stages-rescue.ts — Stock/price rescue stage for the owner pipeline.
// Extracted from owner-handler.stages.ts (C2 batch) to keep that file under 300 lines.
//
// The rescue stage answers simple product price/stock questions ("¿cuánto vale X?",
// "cuánto stock de Y?") from the supervisor context cache, skipping the full
// Supervisor LLM call (~8s p50) with a ~50ms deterministic lookup.

import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import { PRICE_QUERY_RE, STOCK_QUERY_RE } from "./nlu/query-regex";
import { normalizeForMatching, formatMoney } from "./shared";
// Import from ctx.ts (not stages.ts) to avoid a circular dependency:
// stages.ts re-exports ownerStockPriceRescueStage from this file.
import type { OwnerPipelineCtx, OwnerPipelineStage } from "./owner-handler.ctx";

// MUST stay AFTER ownerDeterministicDispatchStage: structured intents (sale,
// procurement / external-agent, etc.) have to win first — otherwise a query
// like "comprar X si el precio es mejor" gets answered as a price lookup
// instead of routed to procurement. Falls through to the supervisor on no match.
function tryRescueStockPriceQuery(
  text: string,
  products: Array<{ name: string; price: number; stock: number }>,
  currency: string,
): string | null {
  const n = normalizeForMatching(text);
  const isPriceQuery = PRICE_QUERY_RE.test(n);
  const isStockQuery = !isPriceQuery && STOCK_QUERY_RE.test(n);
  if (!isPriceQuery && !isStockQuery) return null;
  for (const p of products) {
    const pn = normalizeForMatching(p.name);
    if (!pn || !n.includes(pn)) continue;
    if (isPriceQuery) return `${p.name} vale ${formatMoney(p.price, currency, "es-AR")}.`;
    return `${p.name}: ${p.stock} unidad${p.stock === 1 ? "" : "es"} en stock.`;
  }
  return null;
}

export const ownerStockPriceRescueStage: OwnerPipelineStage = {
  name: "ownerStockPriceRescue",
  run: async (ctx: OwnerPipelineCtx) => {
    const { text, businessId, actorUserId, trace, latency, respond } = ctx.params;
    if (!text || !text.trim()) return null;

    latency.start("preModel");
    // C2 fix (Finding 3): reuse cached context from ownerOnboardingFastPathStage if available.
    if (!ctx.supervisorCtxCache) ctx.supervisorCtxCache = await loadSupervisorContext(businessId);
    const supCtx = ctx.supervisorCtxCache;
    latency.end("preModel");

    const rescued = tryRescueStockPriceQuery(text, supCtx.products, supCtx.currency ?? "ARS");
    if (!rescued) return null;

    trace.add("rescue", "owner-stock-price");
    latency.setMeta("path", "owner-rescue-fast-path");
    latency.emit({ businessId, actorUserId, actorEmployeeId: null });
    return respond({ answer: rescued, actions: [], chips: null, ...trace.toJSON() });
  },
};
