// Pipeline registry — registers chat handler stages by named phase rather
// than by array position. The previous shape (a flat positional array in
// the pipeline-builder file) caused a production bug on 2026-05-09 where
// `preFilterStage` (welcome fallback) sat at index 1 and short-circuited
// bare commands like "deshacer", "cambia el telefono de Juan" and "agua"
// before NLU and the LLM had a chance to interpret them. Named phases make
// that class of bug structurally impossible: a stage declares which phase
// it belongs to, and the registry guarantees the canonical phase order on
// the way out. See issues/001-chat-pipeline-named-phases.md.

import { cloudLog } from "@/lib/cloud-logger";

// Canonical phase order. The flattened pipeline runs phases in the listed
// order; within a phase, stages run in the order they appear in the array
// the caller passed for that phase.
export const Phase = Object.freeze({
  PreAuth: "pre-auth",
  AuthRbac: "auth-rbac",
  PreModelDeterministic: "pre-model-deterministic",
  ModelLlm: "model-llm",
  PostModelFallback: "post-model-fallback",
  Execute: "execute",
  EmitEvents: "emit-events",
  ShapeResponse: "shape-response",
} as const);

export type PhaseName = (typeof Phase)[keyof typeof Phase];

// The canonical order, as a tuple. `buildPhasePipeline` walks this exact
// list — adding/removing/reordering phases happens here in one place.
const PHASE_ORDER: readonly PhaseName[] = [
  Phase.PreAuth,
  Phase.AuthRbac,
  Phase.PreModelDeterministic,
  Phase.ModelLlm,
  Phase.PostModelFallback,
  Phase.Execute,
  Phase.EmitEvents,
  Phase.ShapeResponse,
];

// A stage is a named function that takes the pipeline context and returns
// either a response (short-circuit) or null (continue to next stage).
// Mirrors the existing `PipelineStage` shape in employee-handler.ctx.ts so
// stages do not need to change their function bodies — they just register
// against a phase instead of being concatenated in an array literal.
export interface PhaseStage<TCtx, TResult> {
  name: string;
  run: (ctx: TCtx) => Promise<TResult | null>;
}

export type PhaseStagesByPhase<TCtx, TResult> = Record<
  PhaseName,
  ReadonlyArray<PhaseStage<TCtx, TResult>>
>;

// Tracks pipelines that have already emitted the empty-fallback warning so
// per-request rebuilds of the same pipeline don't spam the logs. The warn
// fires once per pipelineName per process.
const warnedEmptyFallback = new Set<string>();

// Flattens a per-phase record into the positional array the existing
// orchestrator already runs. Performs build-time validation:
//
//   - throws if any phase key is missing from the input record (forcing
//     callers to acknowledge every phase explicitly, even with an empty
//     array — the pipeline shape becomes self-documenting at the call
//     site)
//   - emits a one-shot structured cloudLog warning if the
//     post-model-fallback phase is empty (that empty bucket is exactly the
//     configuration that allowed the 2026-05-09 welcome-fallback bug to
//     ship). Pipelines that legitimately have no model-output gates (e.g.
//     the owner supervisor pipeline whose model stage is also its terminal
//     responder) can suppress by passing `allowEmptyPostModelFallback`.
export function buildPhasePipeline<TCtx, TResult>(
  pipelineName: string,
  stagesByPhase: PhaseStagesByPhase<TCtx, TResult>,
  options: { allowEmptyPostModelFallback?: boolean } = {},
): Array<PhaseStage<TCtx, TResult>> {
  for (const phase of PHASE_ORDER) {
    if (!Object.prototype.hasOwnProperty.call(stagesByPhase, phase)) {
      throw new Error(
        `pipeline-registry: pipeline "${pipelineName}" missing phase "${phase}". ` +
          `Every phase must be present (use [] for empty).`,
      );
    }
  }

  if (
    !options.allowEmptyPostModelFallback &&
    (stagesByPhase[Phase.PostModelFallback] ?? []).length === 0 &&
    !warnedEmptyFallback.has(pipelineName)
  ) {
    warnedEmptyFallback.add(pipelineName);
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "PIPELINE_EMPTY_POST_MODEL_FALLBACK",
      a2a_transfer: false,
      message:
        `pipeline "${pipelineName}" has no stages in the post-model-fallback phase. ` +
        "Welcome/onboarding fallbacks belong here; an empty bucket re-creates the 2026-05-09 bug class.",
      data: { pipelineName },
    });
  }

  const flat: Array<PhaseStage<TCtx, TResult>> = [];
  for (const phase of PHASE_ORDER) {
    for (const stage of stagesByPhase[phase]) {
      flat.push(stage);
    }
  }
  return flat;
}
