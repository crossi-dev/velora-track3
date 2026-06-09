// Thin stage wrappers for the pre-LLM payment-method chip intercept.
// Logic lives in sale-payment-prompt.ts; stages are here to keep the
// owner and employee stage files under the 300-line hard limit.
//
// Both roles share identical stage logic — the only difference used to be
// the TypeScript stage type (OwnerPipelineStage vs PipelineStage). Both
// params types expose `{ text, businessId, respond }` with the same shape,
// so a single shared run function replaces two byte-for-byte-identical bodies.

import type { NextResponse } from "next/server";
import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import {
  detectSaleWithoutPaymentMethod,
  buildSalePaymentPromptResult,
} from "./sale-payment-prompt";
import type { OwnerPipelineStage, OwnerPipelineCtx } from "./owner-handler.stages";
import type { PipelineStage, EmployeePipelineCtx } from "./employee-handler.ctx";

/** Minimal context shape shared by both owner and employee pipeline params. */
interface SalePaymentCtxMin {
  params: {
    text: string;
    businessId: string;
    respond: (body: Record<string, unknown>) => Promise<NextResponse>;
  };
}

/**
 * Shared run function for the sale-payment-prompt stage.
 *
 * Runs BEFORE the deterministic dispatcher. When the user types a sale
 * without a payment method, short-circuits with chips before any LLM call.
 * Both owner and employee params satisfy SalePaymentCtxMin.
 */
async function runSalePaymentPromptStage(
  ctx: SalePaymentCtxMin,
): Promise<NextResponse | null> {
  const { text, businessId, respond } = ctx.params;
  const match = detectSaleWithoutPaymentMethod(text);
  if (!match) return null;

  // loadSupervisorContext has its own in-process cache (90 s).
  const supCtx = await loadSupervisorContext(businessId);
  const businessAcceptsMP = supCtx.mercadoPagoSelected;
  const transferAlias = supCtx.transferAlias ?? null;

  // SalePaymentPromptResult is structurally compatible with
  // Record<string, unknown> — double-cast required by strict TS.
  return respond(
    buildSalePaymentPromptResult(
      match.originalInput,
      businessAcceptsMP,
      transferAlias,
    ) as unknown as Record<string, unknown>,
  );
}

// Owner pipeline stage — runs AFTER ownerOnboardingFastPathStage and
// BEFORE ownerDeterministicDispatchStage.
export const ownerSalePaymentPromptStage: OwnerPipelineStage = {
  name: "ownerSalePaymentPrompt",
  run: (ctx: OwnerPipelineCtx) => runSalePaymentPromptStage(ctx),
};

// Employee pipeline stage — runs AFTER employeeConfirmationFastPathStage
// and BEFORE preModelStage.
export const employeeSalePaymentPromptStage: PipelineStage = {
  name: "employeeSalePaymentPrompt",
  run: (ctx: EmployeePipelineCtx) => runSalePaymentPromptStage(ctx),
};
