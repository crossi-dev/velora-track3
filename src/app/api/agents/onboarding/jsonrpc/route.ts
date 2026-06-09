// A2A JSON-RPC endpoint for the Velora OnboardingAgent.
// Auth: per-tenant derived X-API-Key + X-Agent-Assertion JWT (Ed25519).
// Rebuilt on agent-rpc-factory.ts — removes duplicated auth/rate-limit scaffold.
// AUTH_REQUIRED code aligned to -32004 (factory standard; was -32001 before).
//
// JSON-RPC method: "agent.invoke" with params { text, businessId, actorUserId }.
// Internal callers do not use this endpoint (they call runOnboardingAgent directly).
//
// A2A TRUST FIX (design §7.3, 2026-06-07):
// - caller-supplied `state` is DISCARDED — the handler loads Business by
//   ctx.businessId (authenticated via HMAC) and derives state via
//   fetchSupervisorContext, same path as the live owner pipeline.
// - actorUserId is verified against Business.userId — mismatches are rejected
//   with INVALID_PARAMS so a caller cannot impersonate a different owner.

export const maxDuration = 25;

import { createAgentRpcRoute } from "@/app/api/agents/_lib/agent-rpc-factory";
import { runOnboardingAgent, OnboardingAgentValidationError } from "@/lib/adk/onboarding-agent";
import type { OnboardingCurrentlyDue } from "@/app/api/business-assistant/_lib/onboarding-session-state";
import {
  buildOnboardingState,
  buildCurrentlyDue,
} from "@/app/api/business-assistant/_lib/owner-handler.stages-onboarding-agent";
import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import { prisma } from "@/lib/prisma";
import {
  rpcError,
  rpcResult,
  RPC_ERRORS,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@velora/core-utils/jsonrpc-types";

async function handleOnboardingRpc(
  body: JsonRpcRequest,
  ctx: { businessId: string | null },
): Promise<JsonRpcResponse> {
  if (body.method !== "agent.invoke") {
    return rpcError(body?.id, RPC_ERRORS.METHOD_NOT_FOUND);
  }

  const params = (body.params ?? {}) as Record<string, unknown>;
  const text = typeof params.text === "string" ? params.text : null;
  const actorUserId = typeof params.actorUserId === "string" ? params.actorUserId : null;

  if (!text || !ctx.businessId || !actorUserId) {
    return rpcError(body?.id, RPC_ERRORS.INVALID_PARAMS, "Required: text, businessId, actorUserId");
  }

  // A2A trust fix (design §7.3): load the business by the authenticated
  // ctx.businessId and verify that actorUserId matches the owner on record.
  // Caller-supplied state is intentionally not used — we derive from DB below.
  const business = await prisma.business.findUnique({
    where: { id: ctx.businessId },
    select: { id: true, userId: true },
  });

  if (!business) {
    return rpcError(body?.id, RPC_ERRORS.INVALID_PARAMS, "Business not found");
  }

  if (business.userId !== actorUserId) {
    return rpcError(
      body?.id,
      RPC_ERRORS.INVALID_PARAMS,
      "actorUserId does not match the authenticated business owner",
    );
  }

  // Derive state from the single source of truth (fetchSupervisorContext via
  // loadSupervisorContext), same derivation path as the live owner pipeline.
  const supCtx = await loadSupervisorContext(ctx.businessId);
  const state = buildOnboardingState(supCtx);
  const currentlyDue: OnboardingCurrentlyDue = buildCurrentlyDue(supCtx);

  try {
    const output = await runOnboardingAgent(
      {
        text,
        lang: "es-AR",
        businessId: ctx.businessId,
        actorUserId,
        state,
        recentHistory: [],
        inboundEventId: null,
      },
      currentlyDue,
    );
    return rpcResult(body.id, output);
  } catch (err) {
    if (err instanceof OnboardingAgentValidationError) {
      return rpcError(body.id, RPC_ERRORS.INTERNAL_ERROR, err.message);
    }
    throw err; // factory catch+log handles unexpected errors
  }
}

export const POST = createAgentRpcRoute({
  agentName: "onboarding",
  callerIdentity: "supervisor",
  rateLimit: { bucket: "onboarding-a2a", max: 20, windowSec: 60 },
  handle: handleOnboardingRpc,
});
