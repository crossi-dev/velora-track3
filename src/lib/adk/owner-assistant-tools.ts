// owner-assistant-tools.ts — FunctionTool factories for the Owner Assistant.
//
// Phase 1 covers the 3 intents that currently misfire in the Ventas relay path:
//   - create_product (bizcochuelo bug — verbless noun phrases always miss)
//   - stock_load     (verbless "llegaron N de X a Y" always miss)
//   - adjust_stock   (structured extraction brittle in relay)
//
// Phase 2 adds 4 more intents (additive — behind USE_OWNER_ASSISTANT flag):
//   - register_sale    — records a sale (productName + customerName + autoSend)
//   - return_sale      — undoes N recent sales
//   - register_movement — records a cash movement (gasto/ingreso/sueldo/etc.)
//   - create_customer  — adds a new customer
//
// Phase 3 adds 9 more intents (catalog-edit + supplier + purchase-request + customer delete):
//   - edit_product           — single-field product edit
//   - bulk_price_update      — percentage or absolute bulk price change
//   - delete_product         — remove a product from the catalog
//   - edit_customer          — single-field customer edit
//   - delete_customer        — remove a customer (has_history guard in use-case)
//   - create_supplier        — new supplier record
//   - edit_supplier          — single-field supplier edit
//   - delete_supplier        — remove a supplier
//   - create_purchase_request — procurement order to a supplier
//
// Phase 4 adds 2 read-only list tools (data returned directly to LLM, no CompoundAction):
//   - list_customers  — returns business's customers (name + phone), newest first
//   - list_suppliers  — returns business's suppliers (name + phone + contact)
//
// IMPORTANT: Zod schemas are REUSED from ventas-agent-tools.ts (import, not copy).
// This ensures the typed schema contract is single-source — no drift between
// what Owner Assistant extracts and what the downstream mapper expects.
// Source: plan §4 "ventas-agent-tools.ts Zod schemas — REUSE as source of truth".
//
// Tool return shape for mutations: { intent, data, summary } — identical to Ventas tool
// returns so supervisor-action-mapper.ts handles them unchanged.
// Source: plan §9 "Wire Owner Assistant result through supervisor-action-mapper.ts".
//
// Tool return shape for reads (list_customers, list_suppliers): raw data object.
// The LLM receives this data directly and formulates a text response — no CompoundAction
// needed because these are queries, not mutations.
//
// NOTE: check_stock and business_query remain with the Supervisor per the Phase 3 plan.
// They are read-only queries and work correctly there — no reason to migrate yet.

import type { FunctionTool } from "@google/adk";
import { buildVentasTools } from "@/app/api/agents/ventas/jsonrpc/_lib/ventas-agent-tools";
import { createListCustomersTool } from "./tools/list-customers-tool";
import { createListSuppliersTool } from "./tools/list-suppliers-tool";

// Phase 1 + 2 + 3 mutation intent allowlist.
// Phase 4+ will remove the Flash classifier and slim the Supervisor.
const PHASE3_INTENTS = new Set([
  // Phase 1
  "create_product",
  "stock_load",
  "adjust_stock",
  // Phase 2
  "register_sale",
  "return_sale",
  "register_movement",
  "create_customer",
  // Phase 3
  "edit_product",
  "bulk_price_update",
  "delete_product",
  "edit_customer",
  "delete_customer",
  "create_supplier",
  "edit_supplier",
  "delete_supplier",
  "create_purchase_request",
]);

/**
 * Builds the Owner Assistant FunctionTool set for Phase 1 + Phase 2 + Phase 3 + Phase 4.
 *
 * Mutation tools: filtered from the Ventas tool set (zero schema duplication).
 * Read-only tools: list_customers + list_suppliers — factory functions that bind
 * businessId in closure for tenant isolation. These tools return data directly
 * to the LLM (no CompoundAction path) so the model can answer list queries inline.
 *
 * @param businessId Velora tenant ID — required for list tools' tenant isolation.
 * @returns FunctionTool[] for all Phase 1-4 intents.
 */
export function buildOwnerAssistantTools(businessId: string): FunctionTool[] {
  const mutationTools = buildVentasTools().filter((tool) =>
    PHASE3_INTENTS.has(tool.name),
  );
  const listTools = [
    createListCustomersTool({ businessId }),
    createListSuppliersTool({ businessId }),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- FunctionTool[] satisfies BaseTool[] at runtime
  return [...mutationTools, ...listTools] as any[];
}
