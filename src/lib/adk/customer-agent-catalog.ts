import "server-only";
// customer-agent-catalog.ts — Catalog context summary for the Customer Agent.
//
// Grounding approach: inject a compact real catalog summary into the system
// instruction so the model has accurate product/price/stock data on turn 1
// WITHOUT needing a get_catalog tool call.
//
// Why NOT mode=ANY (the regression that was reverted):
//   mode=ANY forces a tool call on EVERY turn — the model can NEVER emit a
//   final text reply. Every turn loops LLM→tool→LLM→tool until maxLlmCalls
//   is exhausted, then CUSTOMER_AGENT_EMPTY_REPLY fires.
//   Source (verified HTTP 200 2026-05-29):
//     https://ai.google.dev/gemini-api/docs/function-calling
//     "ANY — The model is constrained to always predict a function call."
//   AUTO is kept so the model can produce a text reply at any point.
//
// Why instruction closure over ADK {key} template injection:
//   createAdkAgent() wraps all instructions as callbacks (agent-factory.ts) to
//   avoid ADK template resolution crashing on JSON braces elsewhere in the prompt.
//   Since the instruction is already a callback, we close over the catalogSummary
//   string — no ADK template resolution needed.
//   Source: https://adk.dev/sessions/state/
//     "InstructionProvider — callback that returns the instruction string."

import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";

const CATALOG_FETCH_LIMIT = 20;

/**
 * Fetches the business catalog and builds a compact line-per-product summary
 * for injection into the Customer Agent system instruction.
 * Capped at CATALOG_FETCH_LIMIT (20) products; truncation note appended when DB has more.
 * Non-fatal: errors return a neutral placeholder so the agent still runs.
 *
 * @param businessId — Tenant scope for the product query.
 * @returns Multi-line string: "ProductName: $price (N en stock)\n..." or a neutral placeholder.
 */
export async function buildCatalogSummary(businessId: string): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma regen blocked on Windows DLL lock.
    const products = await (prisma as any).product.findMany({
      where: { businessId },
      select: { id: true, name: true, price: true, quantity: true },
      orderBy: { name: "asc" },
      // Fetch +1 to detect truncation without an extra COUNT query.
      take: CATALOG_FETCH_LIMIT + 1,
    });
    if (!products.length) return "(catálogo vacío — usá get_catalog para verificar)";
    const isTruncated = products.length > CATALOG_FETCH_LIMIT;
    const visible = isTruncated ? products.slice(0, CATALOG_FETCH_LIMIT) : products;
    // Include productId in the summary so the model can pass the correct id
    // to update_order_item without calling get_catalog first.
    // Root-cause fix (2026-05-29): model was passing an invented ID when it
    // relied solely on the catalog summary (no productId in it) → DB lookup
    // always failed → empty cart → create_payment_link rejected with "no items".
    const lines = visible.map(
      (p: { id: string; name: string; price: number; quantity: number }) =>
        `${p.name}: $${Number(p.price)} (${p.quantity} en stock) [productId:${p.id}]`,
    );
    if (isTruncated) lines.push("... (catálogo truncado — usá get_catalog para ver más)");
    return lines.join("\n");
  } catch (err) {
    cloudLog({
      severity: "WARNING",
      component: "CustomerAgent",
      action: "CUSTOMER_AGENT_CATALOG_SUMMARY_ERROR",
      a2a_transfer: false,
      message: `Failed to build catalog summary: ${err instanceof Error ? err.message : String(err)}`,
      data: { businessId },
    });
    return "(catálogo no disponible — usá get_catalog para consultar productos)";
  }
}
