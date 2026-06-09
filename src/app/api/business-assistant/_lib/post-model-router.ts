import { NextResponse } from "next/server";
import {
  normalizeActionText,
  normalizeNonNegativeNumberString,
  normalizePositiveIntegerString,
} from "./shared";
import { matchProductByName } from "./match-product-by-name";
import type {
  AssistantIntent,
  AssistantTaskModelResponse,
} from "./types";
import type { PostModelIntentParams } from "./router-params";
import type { CompoundAction, HandlerResult, IntentHandler } from "./intent-handlers/types";
import { handleRegisterSale } from "./intent-handlers/sale";
import { handleAdjustStock, handleStockLoad } from "./intent-handlers/stock";
import { handleEditProduct } from "./intent-handlers/product";
import { handleDeleteProduct } from "./intent-handlers/product-delete";
import { handleCreateCustomer, handleDeleteCustomer, handleEditCustomer } from "./intent-handlers/customer";
import { handleCreateSupplier, handleEditSupplier } from "./intent-handlers/supplier";
import { handleRegisterMovement } from "./intent-handlers/movement";
import { handleBulkPriceUpdate } from "./intent-handlers/bulk-price";
import { handleBusinessQuery } from "./intent-handlers/business-query";
import { handleReportEvent } from "./intent-handlers/event-report";
import { handleCreatePurchaseRequest } from "./intent-handlers/purchase-request";
import { handleCreateProduct } from "./intent-handlers/product-create";
import { handleCreateBudget } from "./intent-handlers/budget";
import { handleReturnSale } from "./intent-handlers/return-sale";
import { detectActionHallucination, HALLUCINATION_FALLBACK_ANSWER } from "./answer-hallucination-guard";
import { canRoleExecuteIntent } from "./role-contract";
import type { ActorRole } from "@/app/api/_lib/resolve-actor";
import { cloudLog } from "@/lib/cloud-logger";

// Maps Spanish movement type labels (from owner system prompt) to the DB enum.
const MOVEMENT_TYPE_ES_TO_EN: Record<string, string> = {
  gasto: "purchase", ingreso: "income", retiro: "adjustment", sueldo: "salary", otro: "adjustment",
};

// ─── Compound action detection ──────────────────────────────────────────────
//
// A single user message can include multiple actions (e.g. "carga 15 bananas y
// el precio cambia a 500" = stock_load + edit_product). The model returns the
// primary intent in `safeIntent` and additional fields (productEdit,
// stockDraft, movementDraft) for any extras.
// NOTE: adjust_stock and report_event are intentionally excluded — they require
// confirmation or produce no DB write, so they must not appear as direct compound extras.
//
// `extractCompoundActions` returns an array of EXTRA actions, excluding the
// primary type so we don't dispatch the same thing twice. Each one is shaped
// as a runtime action object that the client's `executeAction` understands.

function extractCompoundActions(
  primaryIntent: AssistantIntent | "answer",
  parsed: AssistantTaskModelResponse,
  fullCatalogProducts: Array<{ id: string; name: string; sku: string | null }>,
  actorRole: ActorRole,
): CompoundAction[] {
  const extras: CompoundAction[] = [];

  // RBAC guard: only emit compound extras that the actor's role is allowed to
  // execute. Without this check an employee turn whose model output happens to
  // contain a productEdit or movementDraft extra would receive owner-only
  // CompoundActions that the client could execute, bypassing rbacGateStage
  // (which only gates the primary intent).

  if (
    primaryIntent !== "edit_product" &&
    canRoleExecuteIntent(actorRole, "edit_product") &&
    parsed.productEdit?.field &&
    parsed.productEdit?.value
  ) {
    const productName = normalizeActionText(parsed.product?.name) ?? "";
    const match = productName ? matchProductByName(productName, fullCatalogProducts) : null;
    if (match) {
      const field = parsed.productEdit.field;
      let value: string = parsed.productEdit.value;
      let valid = true;
      if (field === "price" || field === "costPrice") {
        const normalized = normalizeNonNegativeNumberString(value);
        if (!normalized) {
          valid = false;
        } else {
          const numeric = Number(normalized);
          if (!Number.isFinite(numeric) || numeric <= 0) valid = false;
          else value = normalized;
        }
      }
      if (valid) {
        extras.push({
          type: "edit_product",
          product: { id: match.id, name: match.name },
          field,
          value,
        });
      }
    }
  }

  if (
    primaryIntent !== "stock_load" &&
    canRoleExecuteIntent(actorRole, "stock_load") &&
    parsed.stockDraft?.itemName &&
    parsed.stockDraft?.quantity
  ) {
    extras.push({
      type: "stock_load",
      draft: {
        items: [{
          itemName: normalizeActionText(parsed.stockDraft.itemName) ?? "",
          quantity: normalizePositiveIntegerString(parsed.stockDraft.quantity) ?? "",
          unitPrice: normalizeNonNegativeNumberString(parsed.stockDraft.unitPrice) ?? "",
        }],
        supplierName: normalizeActionText(parsed.stockDraft.supplierName) ?? "",
      },
    });
  }

  if (
    primaryIntent !== "register_movement" &&
    canRoleExecuteIntent(actorRole, "register_movement") &&
    parsed.movementDraft?.amount != null &&
    parsed.movementDraft?.description
  ) {
    const rawType = normalizeActionText(parsed.movementDraft.movementType) ?? "";
    const movementType = (MOVEMENT_TYPE_ES_TO_EN[rawType] ?? rawType) || "adjustment";
    extras.push({
      type: "register_movement",
      movement: {
        movementType,
        amount: Number(parsed.movementDraft.amount),
        description: normalizeActionText(parsed.movementDraft.description) ?? "",
      },
    });
  }

  return extras;
}

// ─── Post-model intent routing ──────────────────────────────────────────────
//
// Thin dispatcher: computes compound extras, then hands `params` to each
// per-intent handler in order. First non-null result wins. `NextResponse`
// results bypass the compound wrapper (clarifications / confirmations are
// self-contained). `HandlerBody` results get wrapped via `respond()` so
// compound extras are merged into a flat `actions` array.

const HANDLERS: IntentHandler[] = [
  handleRegisterSale,
  handleStockLoad,
  handleAdjustStock,
  handleEditProduct,
  handleDeleteProduct,
  handleEditSupplier,
  handleCreateSupplier,
  handleEditCustomer,
  handleDeleteCustomer,
  handleCreateCustomer,
  handleRegisterMovement,
  handleBulkPriceUpdate,
  handleBusinessQuery,
  handleReportEvent,
  handleCreatePurchaseRequest,
  handleCreateProduct,
  handleCreateBudget,
  handleReturnSale,
];

export async function handlePostModelIntents(params: PostModelIntentParams): Promise<NextResponse> {
  const { safeIntent, parsed, answer, fullCatalogProducts, trace, actorRole } = params;

  const compoundExtras = extractCompoundActions(safeIntent, parsed, fullCatalogProducts, actorRole);
  if (compoundExtras.length > 0) {
    trace.add("compound", `extras: ${compoundExtras.map((a) => String(a.type)).join(",")}`);
  }

  // Build the response with a flat `actions` array. Primary action (if any)
  // first, then compound extras. Each is dispatched independently on the
  // client with its own try/catch and feedback. Confirmation-only intents
  // emit `actions: []` — execution happens after the user confirms.
  function respond(body: { answer?: string; primaryAction?: CompoundAction | null; [k: string]: unknown }): NextResponse {
    const { primaryAction, ...rest } = body;
    const actions: CompoundAction[] = [];
    if (primaryAction) actions.push(primaryAction);
    actions.push(...compoundExtras);
    return NextResponse.json({ ...rest, actions });
  }

  if (safeIntent === "answer") {
    // Last-line defense: if the model classified this as a query but emitted
    // text that sounds like an action confirmation, suppress it. This catches
    // the case where the model mis-classifies an action turn (so no handler
    // runs and no deterministic template fires) yet still hallucinates "Listo,
    // registrada la venta...". Replacing with a neutral fallback forces the
    // employee to reformulate instead of seeing a fake confirmation.
    const guard = detectActionHallucination(answer);
    if (guard.matched) {
      cloudLog({
        severity: "WARNING",
        component: "Employee",
        action: "ANSWER_HALLUCINATION_BLOCKED",
        a2a_transfer: false,
        message: "Suppressed model-emitted action confirmation in answer-intent turn",
        data: { pattern: guard.patternName, originalAnswerPreview: answer.slice(0, 240) },
      });
      return respond({ answer: HALLUCINATION_FALLBACK_ANSWER, primaryAction: null, ...trace.toJSON() });
    }
    return respond({ answer, primaryAction: null, ...trace.toJSON() });
  }

  for (const handler of HANDLERS) {
    const result: HandlerResult = await handler(params);
    if (result === null) continue;
    if (result instanceof NextResponse) return result;
    return respond(result);
  }

  return NextResponse.json({ answer });
}
