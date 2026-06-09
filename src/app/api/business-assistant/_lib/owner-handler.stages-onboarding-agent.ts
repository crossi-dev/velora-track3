// Owner-handler stage that delegates to OnboardingAgent.
//
// Placement in the pipeline (post 2026-05-30 OA Phase 4 — Flash classifier removed):
//   1. ownerConfirmationFastPathStage
//   2. ownerDeterministicDispatchStage
//   3. ownerFiscalSetupStage
//   4. ownerOnboardingAgentStage     ← THIS  (release-on-action-intent guard)
//   5. ownerDailyNudgeStage, ownerSalePaymentPromptStage, ownerStockPriceRescueStage
//   6. ownerSupervisorStage          (Phase.ModelLlm — Gemini Pro)
//
// Routing rule (single source of truth):
//   - detectPendingTurn(supervisorBusinessContext) === null
//     → return null, downstream stages handle (business is past onboarding)
//   - shouldReleaseOnboardingTurn(text, pendingTurn) === true
//     → return null, OA (flag on) or Pro Supervisor (flag off) handles the action
//   - else → invoke OnboardingAgent
//
// Failure recovery (per OnboardingAgent contract):
//   - Timeout / Parse / Validation error → log distinctly + emit the
//     deterministic re-prompt for the current turn (no fall-through to the
//     supervisor; step 5 complete — supervisor-prompt-onboarding.ts deleted).

import type { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import {
  loadSupervisorContext,
  invalidateSupervisorContext,
} from "@/app/api/supervisor/_lib/load-context";
import {
  fetchFreshCapabilities,
  detectConnectedFlip,
  buildOAuthAck,
  normalizeWhatsappPhoneSetFromRaw,
  claimOAuthAck,
} from "./owner-handler.stages-onboarding-agent.capabilities";
import type { FreshCapabilities, ConnectedIntegration } from "./owner-handler.stages-onboarding-agent.capabilities";
import { detectPendingTurn } from "./onboarding-fast-path";
import type { OwnerPipelineStage } from "./owner-handler.stages";
import { buildOnboardingTurnPrompt } from "./onboarding-fast-path.help-fallback";
import {
  runOnboardingAgent,
  OnboardingAgentTimeoutError,
  OnboardingAgentParseError,
  OnboardingAgentValidationError,
} from "@/lib/adk/onboarding-agent";
import type { OnboardingAgentInput } from "@/lib/adk/onboarding-agent.contract";
import type { OnboardingCurrentlyDue } from "./onboarding-session-state";
import type { FastPathResult } from "./onboarding-fast-path.builders";
// Release-decision logic extracted to a sibling module per the 300-LOC contract.
// See owner-handler.stages-onboarding-agent.release.ts for the full rationale.
import { shouldReleaseOnboardingTurn } from "./owner-handler.stages-onboarding-agent.release";
// State-building helpers split to a sibling to keep this file under the 300-LOC limit.
// Re-exported here so existing test imports (onboarding-currently-due-invariant,
// onboarding-history-mapper) and the A2A route (design §7.3) continue to work.
export {
  buildOnboardingState,
  buildCurrentlyDue,
  mapRecentHistory,
} from "./owner-handler.stages-onboarding-agent.state";
import {
  buildOnboardingState,
  buildCurrentlyDue,
  mapRecentHistory,
} from "./owner-handler.stages-onboarding-agent.state";

async function emitDeterministicReply(
  fallback: FastPathResult,
  respond: (body: Record<string, unknown>) => Promise<NextResponse>,
): Promise<NextResponse> {
  // Deterministic fallbacks (turn re-prompts) are display-only — they
  // do not carry DB-write actions in the new tool-dispatch model. Persistence
  // is handled by the FunctionTool handlers when the LLM runs successfully.
  return respond({ answer: fallback.answer, actions: [], chips: fallback.chips });
}

export const ownerOnboardingAgentStage: OwnerPipelineStage = {
  name: "ownerOnboardingAgent",
  run: async (ctx) => {
    const {
      text, lang, businessId, actorUserId, inboundEventId,
      recentHistory = [], trace, latency, respond,
    } = ctx.params;
    if (!text || !text.trim()) return null;

    latency.start("preModel");
    // H2 (JD Fase 6): reuse the cached supervisor context when populated
    // upstream. ownerStockPriceRescueStage and the deprecated fast-path stage
    // both rely on the same cache to avoid a duplicate Supabase round-trip.
    const supCtx = ctx.supervisorCtxCache
      ?? (ctx.supervisorCtxCache = await loadSupervisorContext(businessId));
    const state = buildOnboardingState(supCtx);
    // businessTypeSet is required by detectPendingTurn's input type but T2
    // is removed from the flow — always pass true so the gate never fires.
    const pendingTurn = detectPendingTurn({ ...state, businessTypeSet: true });
    if (pendingTurn === null) {
      // Onboarding complete — let the supervisor + ops stages own this turn.
      latency.end("preModel");
      return null;
    }

    // Capability cache freshness (design §9): fetch integration-connected state
    // FRESH for onboarding turns, bypassing the 30s in-process cache, so nudging
    // is not based on stale data if the owner just connected an integration.
    // Best-effort: a fetch failure silently falls back to the cached supCtx values.
    // OAuth re-entry handshake (design §6/§14.8): if PROACTIVE_ONBOARDING_ENABLED
    // and a capability just flipped false→true, acknowledge it and return early.
    // Runs only while onboarding is active (we are already inside pendingTurn check).
    let oauthFlipAck: string | null = null;
    let oauthFlipIntegration: ConnectedIntegration | null = null;
    try {
      const cached: FreshCapabilities = {
        mercadoPagoConnected: state.mercadoPagoConnected,
        arcaCertConnected: state.arcaCertConnected,
        courierCredentialsConnected: state.courierCredentialsConnected,
        // W3 fix: supCtx.whatsappPhoneSet uses a lenient check (not-null/undefined),
        // so the deferred sentinel "" evaluates to true. fetchFreshCapabilities uses
        // trim().length > 0 (strict, "" = false). normalizeWhatsappPhoneSetFromRaw
        // applies the strict definition to match fetchFreshCapabilities exactly.
        // This only affects the flip comparison; it does NOT change how
        // whatsappPhoneSet is used elsewhere in the pipeline.
        whatsappPhoneSet: normalizeWhatsappPhoneSetFromRaw(supCtx.whatsappPhoneRaw, state.whatsappPhoneSet),
      };
      const fresh = await fetchFreshCapabilities(businessId);
      state.mercadoPagoConnected = fresh.mercadoPagoConnected;
      state.arcaCertConnected = fresh.arcaCertConnected;
      state.courierCredentialsConnected = fresh.courierCredentialsConnected;
      state.whatsappPhoneSet = fresh.whatsappPhoneSet;
      if (process.env.PROACTIVE_ONBOARDING_ENABLED === "true") {
        const flipped = detectConnectedFlip(cached, fresh);
        if (flipped) {
          oauthFlipIntegration = flipped;
          oauthFlipAck = buildOAuthAck(flipped);
          // W1 fix: evict the 30s in-process cache immediately so the NEXT
          // request on this instance re-reads the DB and cached.* becomes true.
          // Without this, the stale cached value keeps returning false for up
          // to 30s → detectConnectedFlip fires on every turn → repeated ack.
          invalidateSupervisorContext(businessId);
        }
      }
    } catch {
      // Non-blocking: cache values remain in state
    }

    // OAuth re-entry ack (design §6/§14.8, W2).
    // claimOAuthAck inserts an OnboardingOauthAck row (NOT ChatMessage) keyed by
    // (businessId, integration, slotDate). Token is invisible to chat-history and
    // recentAlerts. P2002 or DB error → fall through to normal turn.
    if (oauthFlipAck && oauthFlipIntegration) {
      let claimed = false;
      try {
        claimed = await claimOAuthAck(businessId, oauthFlipIntegration);
      } catch {
        // Transient DB error: log and fall through — turn must not crash.
        cloudLog({
          severity: "WARNING",
          component: "OnboardingAgent",
          action: "OAUTH_REENTRY_ACK_CLAIM_ERROR",
          a2a_transfer: false,
          message: "Onboarding OAuth re-entry: claimOAuthAck threw unexpectedly, falling through to normal turn",
          businessId,
          data: { integration: oauthFlipIntegration },
        });
      }
      if (claimed) {
        cloudLog({
          severity: "INFO",
          component: "OnboardingAgent",
          action: "OAUTH_REENTRY_ACK",
          a2a_transfer: false,
          message: "Onboarding OAuth re-entry: integration connected, emitting ack",
          businessId,
          data: { ack: oauthFlipAck.slice(0, 80) },
        });
        trace.add("routing", "owner → OnboardingAgent OAuth re-entry ack");
        latency.setMeta("path", "owner-onboarding-oauth-reentry");
        latency.emit({ businessId, actorUserId, actorEmployeeId: null });
        latency.end("preModel");
        // Design §6: the owner's message text is intentionally not processed on
        // the ack turn — we acknowledge the connection first; the owner re-sends
        // any intent on the next turn. Combined with W1 (cache invalidation) and
        // the cross-instance claim, this fires at most once per integration per
        // ART day. respond() is the SINGLE persist path for the visible ack.
        return respond({ answer: oauthFlipAck, actions: [], chips: null });
      }
      // P2002 or error: another instance already acked, or transient failure.
      // Fall through to normal turn processing.
      cloudLog({
        severity: "INFO",
        component: "OnboardingAgent",
        action: "OAUTH_REENTRY_ACK_SKIPPED",
        a2a_transfer: false,
        message: "Onboarding OAuth re-entry: ack not claimed (duplicate or error), continuing normal turn",
        businessId,
        data: { integration: oauthFlipIntegration },
      });
    }

    // Release-on-action-intent guard (ADK Coordinator pattern).
    // mightBeActionIntent() regex detects clear action intents (product load,
    // sale, stock adj, etc.) so OnboardingAgent releases the turn to OA or
    // Pro Supervisor. Flash classifier removed 2026-05-30 (OA Phase 4).
    // T5 suppresses the release — single-product entry must advance the state machine.
    // Source (verified HTTP 200 2026-05-28): https://adk.dev/workflows/collaboration/
    if (shouldReleaseOnboardingTurn(text, pendingTurn)) {
      cloudLog({
        severity: "INFO",
        component: "OnboardingAgent",
        action: "ONBOARDING_RELEASED_FOR_ACTION_INTENT",
        a2a_transfer: false,
        message: `OnboardingAgent released turn — mightBeActionIntent matched "${text.slice(0, 80)}"`,
        businessId,
        data: { pendingTurn },
      });
      trace.add(
        "routing",
        `owner → OnboardingAgent released (mightBeActionIntent=true, T${pendingTurn} still pending)`,
      );
      latency.end("preModel");
      return null;
    }

    // Build currently_due for session.state injection (ADK session.state pattern).
    const currentlyDue = buildCurrentlyDue(supCtx);

    const fallback = () => buildOnboardingTurnPrompt(
      pendingTurn,
      state.courierPreference,
      state.pendingStockProduct?.name ?? null,
    );

    // Invoke the OnboardingAgent. Persistence is handled by FunctionTool dispatch
    // inside runOnboardingAgent — no separate persistOnboardingFastPathResult needed.
    try {
      const agentLang: OnboardingAgentInput["lang"] = lang === "en" ? "en-US" : "es-AR";
      const agentOutput = await runOnboardingAgent(
        {
          text,
          lang: agentLang,
          businessId,
          actorUserId,
          state,
          recentHistory: mapRecentHistory(recentHistory),
          inboundEventId,
        },
        currentlyDue,
      );

      trace.add("routing", "owner → OnboardingAgent (currently_due)");
      latency.setMeta("path", "owner-onboarding-agent");
      latency.emit({ businessId, actorUserId, actorEmployeeId: null });
      latency.end("preModel");

      cloudLog({
        severity: "INFO",
        component: "OnboardingAgent",
        action: "ONBOARDING_AGENT_RESOLVED",
        a2a_transfer: false,
        message: "OnboardingAgent resolved via currently_due tool dispatch",
        businessId,
        data: { clientAction: agentOutput.clientAction ?? null },
      });

      return respond({
        answer: agentOutput.answer,
        actions: [],
        chips: agentOutput.chips,
        ...(agentOutput.clientAction !== undefined && { clientAction: agentOutput.clientAction }),
        ...(agentOutput.clientActionParams !== undefined && { clientActionParams: agentOutput.clientActionParams }),
      });
    } catch (err) {
      const action =
        err instanceof OnboardingAgentTimeoutError ? "ONBOARDING_AGENT_TIMEOUT" :
        err instanceof OnboardingAgentValidationError ? "ONBOARDING_AGENT_VALIDATION_FAILED" :
        err instanceof OnboardingAgentParseError ? "ONBOARDING_AGENT_PARSE_FAILED" :
        "ONBOARDING_AGENT_UNEXPECTED_ERROR";
      const severity = err instanceof OnboardingAgentValidationError ? "ERROR" : "WARNING";
      cloudLog({
        severity,
        component: "OnboardingAgent",
        action,
        a2a_transfer: false,
        message: `${action}, falling back to deterministic turn re-prompt`,
        businessId,
        data: {
          turn: pendingTurn,
          error: err instanceof Error ? err.message : String(err),
          inputPreview: text.slice(0, 200),
        },
      });

      trace.add("routing", `owner → OnboardingAgent fallback T${pendingTurn}`);
      latency.setMeta("path", "owner-onboarding-agent-fallback");
      latency.emit({ businessId, actorUserId, actorEmployeeId: null });
      latency.end("preModel");
      return emitDeterministicReply(fallback(), respond);
    }
  },
};

