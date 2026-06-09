// owner-handler.stages-owner-assistant.ts — Owner Assistant pipeline stage (Phase 1-4).
//
// Position in pipeline: AFTER ownerStockPriceRescueStage, BEFORE ownerSupervisorStage.
// Gated by USE_OWNER_ASSISTANT=true (default OFF — behavior identical to today when unset).
//
// Phase 1 intents: create_product, stock_load, adjust_stock.
// Phase 2 intents: register_sale, return_sale, register_movement, create_customer.
// Phase 3 intents: edit_product, bulk_price_update, delete_product, edit_customer,
//                  delete_customer, create_supplier, edit_supplier, delete_supplier,
//                  create_purchase_request.
// Phase 4 intents (read-only list queries — text reply, no CompoundAction):
//                  list_customers, list_suppliers.
// When the agent produces no tool call → returns null → ownerSupervisorStage runs (safe fallback).
// When the agent produces a mutation tool call → maps to CompoundAction via supervisor-action-mapper.
// When the agent produces a list tool call → the LLM text reply IS the answer; returned directly.
//
// Tenant isolation: businessId passed to runOwnerAssistant; all DB queries scoped by it.
// Owner-only: this stage is in the owner pipeline (actorRole guard is upstream in handleOwnerTurn).

import { runOwnerAssistant } from "@/lib/adk/owner-assistant";
import { loadBusinessAssistantContext } from "./context";
import { mapSupervisorActionsToCompoundActions } from "./supervisor-action-mapper";
import { cloudLog } from "@/lib/cloud-logger";
import type { OwnerPipelineCtx, OwnerPipelineStage } from "./owner-handler.ctx";

// Phase 1 + Phase 2 + Phase 3 mutation intents handled by Owner Assistant.
// The stage always runs when the flag is on (not pre-filtered by regex),
// but returns null on no-tool-call so the Supervisor handles misses cleanly.
const ALLOWED_INTENTS = new Set([
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

// Phase 4 — read-only list intents. The LLM text reply IS the response;
// no CompoundAction is built. These never reach the supervisor-action-mapper.
const LIST_INTENTS = new Set(["list_customers", "list_suppliers"]);

export const ownerAssistantStage: OwnerPipelineStage = {
  name: "ownerAssistant",
  run: async (ctx: OwnerPipelineCtx) => {
    // Feature flag gate — default OFF.
    // When unset/false, behavior is IDENTICAL to today (Supervisor path runs next).
    if (process.env.USE_OWNER_ASSISTANT !== "true") return null;

    const { text, businessId, actorUserId, trace, latency, respond } = ctx.params;
    if (!text || !text.trim()) return null;

    latency.start("ownerAssistant");

    let result;
    try {
      result = await runOwnerAssistant({ businessId, actorUserId, text });
    } catch (err) {
      latency.end("ownerAssistant");
      cloudLog({
        severity: "ERROR",
        component: "OwnerAssistant",
        action: "OWNER_ASSISTANT_STAGE_ERROR",
        a2a_transfer: false,
        message: `Owner Assistant stage threw: ${err instanceof Error ? err.message : String(err)}`,
        data: { businessId },
      });
      // Fail-open: return null so Supervisor handles the turn.
      return null;
    }

    latency.end("ownerAssistant");

    // No tool call produced → fall through to Supervisor (safe fallback).
    if (!result.toolCall) {
      trace.add("ownerAssistant", "no tool call → falling through to Supervisor");
      return null;
    }

    const { intent } = result.toolCall;

    // Phase 4 — list_customers / list_suppliers return data directly to the LLM
    // which formulates a text reply. No CompoundAction needed.
    if (LIST_INTENTS.has(intent)) {
      const answer = result.text.trim();
      if (!answer) {
        trace.add("ownerAssistant", `list intent=${intent} but no text reply → falling through`);
        return null;
      }
      trace.add("routing", `owner → ownerAssistant (${intent}, text-only)`);
      latency.setMeta("path", "owner-assistant");
      latency.emit({ businessId, actorUserId, actorEmployeeId: null });
      return respond({ answer, actions: [], chips: null, ...ctx.params.trace.toJSON() });
    }

    // Only Phase 1 + Phase 2 + Phase 3 mutation intents are claimed — others fall through.
    // This prevents the agent from accidentally claiming intents it can't handle yet.
    if (!ALLOWED_INTENTS.has(intent)) {
      trace.add("ownerAssistant", `intent=${intent} not in allowed set → falling through`);
      return null;
    }

    trace.add("routing", `owner → ownerAssistant (${intent})`);
    latency.setMeta("path", "owner-assistant");

    // Map the { intent, data, summary } tool call through the existing mapper.
    // This is the SAME mapper used by the Supervisor path, so CompoundAction shapes
    // are identical — no client changes needed.
    const loaded = await loadBusinessAssistantContext(businessId);
    const actions = loaded
      ? mapSupervisorActionsToCompoundActions(
          [result.toolCall],
          loaded.fullCatalogProducts,
          loaded.fullCatalogCustomers,
          loaded.fullCatalogSuppliers,
        )
      : [];

    // Guard: if the mapper produced no actions (rare — loadBusinessAssistantContext returned
    // null due to a DB error), fall through to Supervisor instead of producing an empty
    // response bubble. The Supervisor has its own error recovery path.
    if (actions.length === 0 && !result.text.trim()) {
      trace.add("ownerAssistant", "mapper returned no actions + no text → falling through to Supervisor");
      return null;
    }

    // Build a confirmation message. The model's text reply (if any) is used as-is;
    // when empty, synthesize a brief confirmation matching the Supervisor's fallback
    // pattern (owner-handler.ts line ~228).
    let answer = result.text.trim();
    if (!answer && actions.length > 0) {
      const first = actions[0];
      if (first.type === "create_product") {
        const { name, price, stock } = first.product;
        answer = `"${name}" listo para crear — $${price}${stock > 0 ? ` (stock: ${stock})` : ""}.`;
      } else if (first.type === "stock_load") {
        const { supplierName, items } = first.draft;
        const item = items[0];
        answer = `Ingreso de ${item?.itemName ?? "mercadería"}${supplierName ? ` de ${supplierName}` : ""} listo para confirmar.`;
      } else if (first.type === "adjust_stock") {
        answer = `Ajuste de stock listo para confirmar.`;
      } else if (first.type === "register_sale") {
        answer = `Venta lista para confirmar.`;
      } else if (first.type === "undo") {
        answer = `Deshaciendo venta.`;
      } else if (first.type === "register_movement") {
        answer = `Movimiento de caja listo para confirmar.`;
      } else if (first.type === "create_customer") {
        answer = `Cliente listo para registrar.`;
      } else if (first.type === "edit_product") {
        answer = `Cambio en producto listo para confirmar.`;
      } else if (first.type === "bulk_price_update") {
        answer = `Actualización de precios lista para confirmar.`;
      } else if (first.type === "delete_product") {
        answer = `Eliminación de producto lista para confirmar.`;
      } else if (first.type === "edit_customer") {
        answer = `Cambio en cliente listo para confirmar.`;
      } else if (first.type === "create_supplier") {
        answer = `Proveedor listo para registrar.`;
      } else if (first.type === "edit_supplier") {
        answer = `Cambio en proveedor listo para confirmar.`;
      } else if (first.type === "delete_supplier") {
        answer = `Eliminación de proveedor lista para confirmar.`;
      } else if (first.type === "delete_customer") {
        answer = `Eliminación de cliente lista para confirmar.`;
      } else if (first.type === "create_purchase_request") {
        answer = `Pedido de compra listo para confirmar.`;
      } else {
        answer = "Hecho.";
      }
    }

    latency.emit({ businessId, actorUserId, actorEmployeeId: null });

    return respond({
      answer,
      actions,
      chips: null,
      ...ctx.params.trace.toJSON(),
    });
  },
};
