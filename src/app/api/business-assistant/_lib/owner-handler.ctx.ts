import type { NextResponse } from "next/server";
import type { LatencyTracker } from "./latency-tracker";
import type { PendingConfirmationCarrier } from "./nlu/pending-confirmation";
import type { SupervisorBusinessContext } from "@/app/api/supervisor/_lib/load-context";
import type { PhaseStage } from "./pipeline-registry";

type RespondFn = (body: Record<string, unknown>, status?: number) => Promise<NextResponse>;
type Trace = { add: (step: string, detail: string) => void; toJSON: () => Record<string, unknown> | null };
// History entries optionally carry the confirmationRequest emitted on that
// assistant turn so the confirmation fast-path can detect a pending action
// without round-tripping the model. See nlu/pending-confirmation.ts.
type HistoryTurn = PendingConfirmationCarrier;

export interface OwnerTurnParams {
  text: string;
  lang: "en" | "es-AR";
  businessId: string;
  actorUserId: string;
  inboundEventId: string | null;
  respond: RespondFn;
  cacheAndReturn: (res: import("next/server").NextResponse) => Promise<import("next/server").NextResponse>;
  trace: Trace;
  latency: LatencyTracker;
  recentHistory?: HistoryTurn[];
}

// Re-export for consumers that import from ctx.
export type { SupervisorBusinessContext };

// Injected at pipeline construction time so stages don't depend on the
// concrete supervisor module. Keeps owner-handler.stages.ts free of the
// large supervisor-runner closure that lives in owner-handler.ts.
export type OwnerSupervisorRunner = (
  text: string,
  lang: "en" | "es-AR",
  businessId: string,
  actorUserId: string,
  inboundEventId: string | null,
  recentHistory: HistoryTurn[],
  respond: RespondFn,
  trace: Trace,
  latency: LatencyTracker,
) => Promise<NextResponse>;

/**
 * Shared pipeline context threaded through every owner stage.
 * Defined here (not in owner-handler.stages.ts) so sibling stage modules
 * (e.g. owner-handler.stages-rescue.ts) can import it without creating a
 * circular dependency with owner-handler.stages.ts.
 */
export interface OwnerPipelineCtx {
  params: OwnerTurnParams;
  runSupervisor: OwnerSupervisorRunner;
  // C2 fix (Finding 3): cache loadSupervisorContext() result across stages.
  // ownerOnboardingFastPathStage and ownerStockPriceRescueStage both call it;
  // caching here eliminates the duplicate DB round-trip on the fast-path-miss
  // → supervisor flow when both stages are traversed on the same request.
  supervisorCtxCache?: SupervisorBusinessContext;
  // classifiedIntent removed 2026-05-30 (OA Phase 4 cleanup).
  // Flash classifier (ownerIntentClassifierStage) removed from pipeline.
  // Onboarding release gate now uses mightBeActionIntent() regex — no LLM call needed.
}

/** Convenience alias — every owner pipeline stage shares this signature. */
export type OwnerPipelineStage = PhaseStage<OwnerPipelineCtx, NextResponse>;
