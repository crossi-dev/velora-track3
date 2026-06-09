// Executor for the create_product Fast Path. Lives in a sibling file to
// keep nlu/dispatch.ts under the 300-line size ceiling. Mirrors the shape
// of executeInvoice / executeCobroQr — pure function over an already-
// detected intent + dispatcher params, returns a NextResponse.
//
// RBAC: gateIntentByRole is the canonical gate. Empleados already rebound
// in `owner_only_blocked` upstream (priority 0 in nlu/detect.ts); this
// gate is defense-in-depth for direct callers.

import { NextResponse } from "next/server";
import { gateIntentByRole } from "../intent-permissions";
import { buildConfirmationRequest } from "../confirmation";
import type { CreateProductIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

export function executeCreateProduct(
  intent: CreateProductIntent,
  params: PreModelIntentParams,
): NextResponse {
  const rbac = gateIntentByRole({
    intent: "create_product",
    role: params.actorRole,
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId,
    trace: { add: () => {}, toJSON: () => null },
  });
  if (rbac) return rbac;

  const stockSuffix = intent.stock > 0 ? ` con ${intent.stock} unidades de stock inicial` : "";
  const weightSuffix = intent.weightGrams ? `, ${intent.weightGrams}g por unidad` : "";
  const answer = `Te paso a confirmar el alta del producto "${intent.name}" a $${intent.price}${stockSuffix}${weightSuffix}.`;
  const confirmMessage = `¿Creo el producto "${intent.name}" a $${intent.price}${stockSuffix}${weightSuffix}?`;

  return NextResponse.json({
    answer,
    confirmationRequest: buildConfirmationRequest({
      severity: "warning",
      title: "Crear producto",
      message: confirmMessage,
      action: {
        type: "create_product",
        product: {
          name: intent.name,
          price: intent.price,
          stock: intent.stock,
          weightGrams: intent.weightGrams ?? null,
        },
      },
    }),
  });
}
