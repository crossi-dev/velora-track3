// Executor for the delete_product Fast Path. Mirrors the confirmation-card
// shape of the existing intent-handlers/product-delete.ts handler so the
// client modal UX is identical to the LLM Slow Path.
//
// RBAC: owner-only. Empleados rebound earlier via owner_only_blocked
// (priority 0 in nlu/detect.ts); this gate is defense-in-depth.

import { NextResponse } from "next/server";
import { gateIntentByRole } from "../intent-permissions";
import { buildConfirmationRequest } from "../confirmation";
import { findProductInfoMatch } from "../handlers/inventory-matching";
import { computeNameMatchScore } from "../handlers/match-score";
import type { DeleteProductIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

// Minimum score to proceed directly to the confirmation card without
// asking the owner to verify the candidate name.
// computeNameMatchScore returns 100 for exact normalized match and 80 for
// substring containment. We require 100 so that "tornillos" → "destornilladores"
// (score 80, substring) never silently queues for deletion.
const DELETE_EXACT_MATCH_THRESHOLD = 90;

export function executeDeleteProduct(
  intent: DeleteProductIntent,
  params: PreModelIntentParams,
): NextResponse {
  const rbac = gateIntentByRole({
    intent: "delete_product",
    role: params.actorRole,
    businessId: params.businessId,
    actorEmployeeId: params.actorEmployeeId,
    trace: { add: () => {}, toJSON: () => null },
  });
  if (rbac) return rbac;

  const { match, ambiguous } = findProductInfoMatch(
    intent.productText,
    params.productInfoDirectory,
  );

  if (ambiguous) {
    return NextResponse.json({
      answer: `Encontré varios productos parecidos a "${intent.productText}". Decime el nombre exacto.`,
      inputHint: "Nombre exacto del producto",
    });
  }

  if (!match) {
    return NextResponse.json({
      answer: `No encontré "${intent.productText}" en tu catálogo.`,
    });
  }

  // Guard: if the match is fuzzy (score < threshold), ask for explicit
  // confirmation of the candidate name before queuing the deletion.
  const matchScore = computeNameMatchScore(intent.productText, match.name, true);
  if (matchScore < DELETE_EXACT_MATCH_THRESHOLD) {
    return NextResponse.json({
      answer: `¿Quisiste decir "${match.name}"? Confirmá si querés borrar ese producto.`,
      confirmationRequest: buildConfirmationRequest({
        severity: "warning",
        title: "Confirmar producto a eliminar",
        message: `No encontré "${intent.productText}" exactamente. ¿Eliminar "${match.name}"? Esta acción no se puede deshacer.`,
        action: { type: "delete_product", product: { id: match.id, name: match.name } },
      }),
    });
  }

  const product = { id: match.id, name: match.name };
  return NextResponse.json({
    answer: `¿Eliminar "${product.name}"?`,
    confirmationRequest: buildConfirmationRequest({
      severity: "warning",
      title: "Confirmar eliminación",
      message: `¿Eliminar el producto "${product.name}"? Esta acción no se puede deshacer.`,
      action: { type: "delete_product", product },
    }),
  });
}
