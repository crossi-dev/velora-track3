import { NextResponse } from "next/server";
import type { ActorRole } from "@/app/api/_lib/resolve-actor";
import type { LoadedBusinessAssistantContext } from "./types";
import type { createAssistantTrace } from "./trace";
import type { createLatencyTracker } from "./latency-tracker";
import type { PendingConfirmationCarrier } from "./nlu/pending-confirmation";
import {
  buildEmployeeStages,
  type EmployeePipelineCtx,
  type PipelineStage,
} from "./employee-handler.stages";
import { maybeNotifyPermissionExpiration } from "./permission-expiration";

export interface EmployeeTurnParams {
  text: string;
  locale: string | null | undefined;
  lang: "en" | "es-AR";
  businessId: string;
  actorEmployeeId: string | null;
  actorUserId: string;
  role: ActorRole;
  inboundEventId: string | null;
  respond: (body: Record<string, unknown>, status?: number) => Promise<NextResponse>;
  cacheAndReturn: (res: NextResponse) => Promise<NextResponse>;
  trace: ReturnType<typeof createAssistantTrace>;
  latency: ReturnType<typeof createLatencyTracker>;
  // History entries optionally carry the confirmationRequest emitted on
  // that assistant turn so the confirmation fast-path can detect a
  // pending action without round-tripping the model.
  recentHistory: PendingConfirmationCarrier[];
  loadedContext: LoadedBusinessAssistantContext;
  activeInvoiceId: string | undefined;
  latestPurchaseRequestId: string | undefined;
  latestPurchaseRequestNumber: string | undefined;
}

async function runEmployeePipeline(
  stages: PipelineStage[],
  ctx: EmployeePipelineCtx,
): Promise<NextResponse> {
  for (const stage of stages) {
    const result = await stage.run(ctx);
    if (result !== null) return result;
  }
  throw new Error("pipeline exhausted without response");
}

export async function handleEmployeeTurn(
  params: EmployeeTurnParams,
): Promise<NextResponse> {
  // Check for expired permission requests before the pipeline so any
  // expiration bubble lands in the same turn the employee next opens chat.
  if (params.actorEmployeeId) {
    try {
      await maybeNotifyPermissionExpiration(params.businessId, params.actorEmployeeId);
    } catch {
      // non-fatal — never block the employee turn
    }
  }

  const ctx: EmployeePipelineCtx = {
    params,
    onboardingPrefix: "",
    modelResult: null,
    parsed: null,
    safeIntent: null,
    answer: null,
  };

  return runEmployeePipeline(buildEmployeeStages(), ctx);
}
