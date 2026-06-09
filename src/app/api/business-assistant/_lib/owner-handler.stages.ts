import type { NextResponse } from "next/server";
import { dispatchDeterministicIntent } from "./nlu/dispatch";
import { mightBeDeterministicIntent } from "./nlu/detect";
import { looksLikeUndoRequest } from "./confirmation";
import { loadBusinessAssistantContext } from "./context";
import { Phase, buildPhasePipeline } from "./pipeline-registry";
import { runConfirmationFastPath } from "./confirmation-fast-path";
// OwnerPipelineCtx + OwnerPipelineStage are defined in owner-handler.ctx.ts so
// sibling modules (e.g. owner-handler.stages-rescue.ts) can import them without
// creating a circular dependency with this file.
export type { OwnerPipelineCtx, OwnerPipelineStage } from "./owner-handler.ctx";
import type { OwnerPipelineCtx, OwnerPipelineStage } from "./owner-handler.ctx";
import { ownerSalePaymentPromptStage } from "./sale-payment-prompt.stages";
import { ownerFiscalSetupStage } from "./owner-handler.stages.fiscal-setup";
import { ownerDailyNudgeStage } from "./owner-handler.stages-daily-nudge";
// ownerOnboardingLlmStage is the step-3/5 rename of ownerOnboardingAgentStage.
// The stage implementation is unchanged; only the pipeline position changes
// (ownerOnboardingFastPathStage removed — the LLM front-door now handles all
// 4 currently_due fields via FunctionTool dispatch).
import { ownerOnboardingAgentStage as ownerOnboardingLlmStage } from "./owner-handler.stages-onboarding-agent";
export { ownerStockPriceRescueStage } from "./owner-handler.stages-rescue";
import { ownerStockPriceRescueStage } from "./owner-handler.stages-rescue";
// ownerIntentClassifierStage (Flash enum classifier, Layer 2) removed 2026-05-30.
// All 6 formerly-dispatchable intents (PAYMENT_LINK, INVOICE_*, SHIPPING_*) are
// covered by L1 labels (3z, 9, 8a) and the OA now owns all mutation intents.
// The onboarding release gate was replaced with mightBeActionIntent() regex.
// Owner Assistant — Phase 1 extraction stage (USE_OWNER_ASSISTANT=true flag-gated).
import { ownerAssistantStage } from "./owner-handler.stages-owner-assistant";

// Fast Path para "sí" / "no" cuando la pantalla muestra una confirmationRequest.
// Sin esto el texto del usuario vuelve a Gemini Pro (4-8s) para resolver un
// 1-bit. Si el último turno asistente trae un confirmationRequest y el input
// del usuario matchea el detector, devolvemos clientAction inline para que
// el cliente ejecute la acción pendiente (Sí) o limpie el estado (No).
// Si el input es ambiguo ("sí, pero cambiá el monto") retorna null y cae al
// supervisor como antes.
export const ownerConfirmationFastPathStage: OwnerPipelineStage = {
  name: "ownerConfirmationFastPath",
  run: async (ctx) => {
    const { text, recentHistory = [], respond, trace, latency, businessId, actorUserId } = ctx.params;
    return runConfirmationFastPath({ text, recentHistory, respond, trace, latency, businessId, actorUserId, actorEmployeeId: null, role: "owner" });
  },
};

// Three Tier NLU para owner — mismo patrón que companion. Si el texto
// contiene algún hint que pueda disparar un intent determinístico (cómo va
// el día, armame un reporte, etc), cargamos contexto + corremos NLU. Si
// dispara, response inmediato (~150ms vs 4s del LLM); si no, fall through
// al supervisor.
export const ownerDeterministicDispatchStage: OwnerPipelineStage = {
  name: "ownerDeterministicDispatch",
  run: async (ctx) => {
    const { text, businessId, actorUserId, recentHistory = [], trace, latency, cacheAndReturn } = ctx.params;

    // Pre-check: regex hint OR explicit undo phrasing. The regex stems use
    // \b boundaries that only fire when followed by a non-word char (the
    // accented variants "borrá"/"deshacé" match; the plain forms "borra"/
    // "deshacé eso"/"deshace" don't — they'd otherwise slip past the
    // dispatcher and hit the Supervisor LLM with no chat context, producing
    // an empty/confused answer). looksLikeUndoRequest is the canonical
    // detector — let it gate explicitly so undo always routes deterministic.
    if (!mightBeDeterministicIntent(text) && !looksLikeUndoRequest(text)) return null;

    latency.start("preModel");
    const loadedContext = await loadBusinessAssistantContext(businessId);
    if (!loadedContext) {
      latency.end("preModel");
      return null;
    }

    const dispatched = await dispatchDeterministicIntent({
      text,
      locale: "es-AR",
      recentHistory,
      context: loadedContext.context,
      business: loadedContext.business,
      productInfoDirectory: loadedContext.productInfoDirectory,
      supplierDirectory: loadedContext.supplierDirectory,
      invoiceDirectory: loadedContext.invoiceDirectory,
      purchaseRequestDirectory: loadedContext.purchaseRequestDirectory,
      activeInvoiceId: undefined,
      latestPurchaseRequestId: undefined,
      latestPurchaseRequestNumber: undefined,
      actorRole: "owner",
      businessId,
      actorUserId,
      actorEmployeeId: null,
    });
    latency.end("preModel");

    if (!dispatched) return null;

    latency.setMeta("path", "owner-pre-model");
    latency.emit({ businessId, actorUserId, actorEmployeeId: null });
    trace.add("routing", "owner → dispatcher (deterministic)");
    // Route through finalisePost (via cacheAndReturn) so the assistant reply
    // is persisted — same gate the employee deterministic path uses.
    // Without this, fast-path turns write the user bubble but drop the reply.
    return cacheAndReturn(dispatched);
  },
};

export const ownerSupervisorStage: OwnerPipelineStage = {
  name: "ownerSupervisor",
  run: async (ctx) => {
    const {
      text, lang, businessId, actorUserId, inboundEventId, recentHistory = [], respond, trace, latency,
    } = ctx.params;
    trace.add("routing", "owner → supervisor");
    return ctx.runSupervisor(
      text, lang, businessId, actorUserId, inboundEventId, recentHistory, respond, trace, latency,
    );
  },
};

export function buildOwnerStages(): OwnerPipelineStage[] {
  // Owner pipeline: fewer stages than employee (no explicit RBAC gate — owner is top role).
  // Supervisor LLM call is in ModelLlm; post-model-fallback intentionally empty.
  return buildPhasePipeline<OwnerPipelineCtx, NextResponse>(
    "owner",
    {
      [Phase.PreAuth]: [],
      [Phase.AuthRbac]: [],
      // Pipeline order (post 2026-05-28 — Fase 6 ADK Coordinator reorder):
      //
      //   ADK Coordinator pattern (verified HTTP 200 2026-05-28):
      //     https://adk.dev/workflows/collaboration/
      //     https://docs.cloud.google.com/architecture/choose-design-pattern-agentic-ai-system
      //
      //   Order (post 2026-05-30 OA Phase 4 cleanup — Flash classifier removed):
      //     Confirmation → DeterministicDispatch → FiscalSetup
      //     → OnboardingLlm (specialist — mightBeActionIntent release gate)
      //     → DailyNudge → SalePaymentPrompt → StockPriceRescue
      //     → Supervisor Pro (Layer 3 — Phase.ModelLlm)
      //
      //   Flash classifier (ownerIntentClassifierStage, Layer 2) removed 2026-05-30 because:
      //   - All 6 dispatchable intents had duplicate L1 labels (3z=PAYMENT_LINK,
      //     9=INVOICE_*, 8a=SHIPPING_*). Flash added ~100-300ms with zero routing value.
      //   - Onboarding release gate replaced with mightBeActionIntent() regex (~25 lines)
      //     so OnboardingAgent can release turns for action intents without an LLM call.
      //   - OA (USE_OWNER_ASSISTANT=true) now owns all mutation intents (Phase 1-3).
      // ownerAssistantStage stays last (the OA extraction stage, flag-gated).
      [Phase.PreModelDeterministic]: [ownerConfirmationFastPathStage, ownerDeterministicDispatchStage, ownerFiscalSetupStage, ownerOnboardingLlmStage, ownerDailyNudgeStage, ownerSalePaymentPromptStage, ownerStockPriceRescueStage, ownerAssistantStage],
      [Phase.ModelLlm]: [ownerSupervisorStage],
      [Phase.PostModelFallback]: [],
      [Phase.Execute]: [],
      [Phase.EmitEvents]: [],
      [Phase.ShapeResponse]: [],
    },
    { allowEmptyPostModelFallback: true },
  );
}
