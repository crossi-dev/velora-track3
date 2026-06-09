export type { EmployeePipelineCtx, PipelineStage } from "./employee-handler.ctx";

import type { NextResponse } from "next/server";
import type { EmployeePipelineCtx, PipelineStage } from "./employee-handler.ctx";
import { Phase, buildPhasePipeline } from "./pipeline-registry";
import {
  employeeConfirmationFastPathStage,
  onboardingStage,
  preFilterStage,
  b2BypassStage,
  permissionEscalationStage,
  correctionDetectStage,
  preModelStage,
  modelStage,
  operationalQuestionStage,
} from "./employee-handler.stages-a";
import { employeeSalePaymentPromptStage } from "./sale-payment-prompt.stages";
import { employeeDailyWelcomeStage } from "./employee-handler.stages-daily-welcome";
import {
  inventoryEscalationStage,
  missedIntentLogStage,
  payloadValidationStage,
  clarificationGateStage,
  confidenceGateStage,
  rbacGateStage,
  stockIngressStage,
  postModelStage,
} from "./employee-handler.stages-b";

export function buildEmployeeStages(): PipelineStage[] {
  // Each stage is registered against a named phase from the canonical phase
  // order in pipeline-registry.ts. Adding a new stage means picking a phase,
  // not an array index. The 2026-05-09 production bug — preFilterStage at
  // index 1 short-circuiting bare commands like "deshacer" / "agua" /
  // "cambia el telefono de Juan" before NLU and LLM ran — is structurally
  // impossible under this model: preFilterStage lives in ShapeResponse,
  // the very last phase, where it acts as a defensive welcome guard for
  // the case nothing upstream returned.
  return buildPhasePipeline<EmployeePipelineCtx, NextResponse>("employee", {
    [Phase.PreAuth]: [onboardingStage, correctionDetectStage],
    [Phase.AuthRbac]: [permissionEscalationStage],
    [Phase.PreModelDeterministic]: [employeeConfirmationFastPathStage, employeeSalePaymentPromptStage, employeeDailyWelcomeStage, preModelStage],
    // b2BypassStage runs AFTER NLU fast-path (preModelStage) so a deterministic
    // intent match short-circuits before the Pro-model escalation fires, even on
    // long inputs (>240 chars). Previously lived in AuthRbac, which caused the
    // bypass to trigger before any NLU ran — wasting a Pro-model call for inputs
    // the Companion NLU could resolve for $0.
    [Phase.ModelLlm]: [b2BypassStage, modelStage],
    [Phase.PostModelFallback]: [
      inventoryEscalationStage,
      missedIntentLogStage,
      payloadValidationStage,
      // rbacGateStage runs before confidenceGateStage so owner-only intents
      // get a warm refusal before the confidence-clarification path fires.
      // An employee triggering an owner-only action with high confidence must
      // see "esa acción la tiene que hacer el dueño" — not "¿quisiste decir X?".
      rbacGateStage,
      clarificationGateStage,
      confidenceGateStage,
    ],
    [Phase.Execute]: [stockIngressStage, postModelStage],
    [Phase.EmitEvents]: [],
    [Phase.ShapeResponse]: [operationalQuestionStage, preFilterStage],
  });
}
