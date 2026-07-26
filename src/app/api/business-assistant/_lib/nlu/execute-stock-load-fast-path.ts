// Executor for the stock_load_fast_path deterministic intent.
// Resolves productHint against the catalog and calls publishStockIngressRequest.
// Falls back to a clarification response when the product can't be matched.

import { NextResponse } from "next/server";
import { findProductInfoMatch } from "../handlers/inventory-matching";
import { publishStockIngressRequest } from "@/app/api/_lib/agent-event-publishers";
import { logUnauthorizedAccess } from "@/lib/cloud-logger";
import { buildCompanionRefusal } from "../intent-permissions";
import type { StockLoadIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

export async function executeStockLoadFastPath(
  intent: StockLoadIntent,
  params: PreModelIntentParams,
): Promise<NextResponse> {
  // RBAC: stock_load is employee-allowed; owner is also fine. No blocking.
  // (owner_only_blocked fires upstream before we reach here for owner-only intents.)

  // Warm reject if role has no permission (edge case — belt-and-suspenders).
  if (params.actorRole && params.actorRole !== "owner" && params.actorRole !== "employee") {
    const refusal = buildCompanionRefusal("stock_load");
    logUnauthorizedAccess({
      attemptedAction: "stock_load_fast_path",
      actorRole: params.actorRole,
      endpoint: "/api/business-assistant [nlu stock_load_fast_path]",
      businessId: params.businessId,
      actorEmployeeId: params.actorEmployeeId ?? undefined,
    });
    return NextResponse.json({ answer: refusal.answer });
  }

  const { match, ambiguous } = findProductInfoMatch(
    intent.productHint,
    params.productInfoDirectory,
  );

  if (ambiguous) {
    return NextResponse.json({
      answer: `Encontré varios productos parecidos a "${intent.productHint}". ¿Cuál llegó?`,
      inputHint: "Ej: llegaron 12 Coca Cola 500ml a 800",
    });
  }

  if (!match) {
    return NextResponse.json({
      answer: `No encontré "${intent.productHint}" en el catálogo. ¿Podés confirmar el nombre del producto?`,
      inputHint: "Ej: llegaron 12 Coca Cola a 800 pesos",
    });
  }

  // Owner short-circuit: open AssistantStockDraft with a pre-filled draft so
  // the owner reviews the item, quantity, and cost price before confirming via
  // stock-load.create — same use-case as QuickStockForm and the ADK stock_load
  // tool. publishStockIngressRequest is the employee approval flow; the owner
  // IS the approver, so we skip it and go straight to the StockLoad record.
  if (params.actorRole === "owner") {
    const qty = intent.quantity;
    // Resolve effective unit cost: prefer explicit user-supplied cost, fall back
    // to the catalog price so the draft always shows a price reference.
    const effectiveCost = intent.unitCost ?? match.price;
    return NextResponse.json({
      answer: `Preparé la carga de stock. Revisá los detalles y confirmá.`,
      primaryAction: {
        type: "stock_load",
        draft: {
          items: [{ itemName: match.name, quantity: String(qty), unitPrice: effectiveCost > 0 ? String(effectiveCost) : "" }],
          supplierName: "",
        },
      },
    });
  }

  // Resolve effective unit cost: prefer explicit user-supplied cost, fall back
  // to the catalog price so the stock ingress record is never created with $0.
  const effectiveUnitCost = intent.unitCost ?? match.price ?? 0;

  const item = {
    productName: match.name,
    quantity: intent.quantity,
    unitCostPrice: effectiveUnitCost,
  };

  const decision = await publishStockIngressRequest({
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId,
    items: [item],
    supplierName: null,
  });

  const chatAnswer =
    decision.approved && !decision.anomaly
      ? `Ingreso anotado: ${intent.quantity} ${match.name} a $${effectiveUnitCost}. El dueño lo verá en el inventario.`
      : `Avisé del ingreso, pero el dueño tiene que confirmarlo: ${decision.reason}`;

  return NextResponse.json({
    answer: chatAnswer,
    actions: [{
      type: "stock_ingress_reported",
      productName: match.name,
      quantity: intent.quantity,
      unitPrice: effectiveUnitCost,
    }],
  });
}
