/**
 * Shared helper for the three employee-pipeline escalation paths that all
 * call runSupervisor with the same context shape and then fire-and-forget
 * publishSupervisorQuery + publishCompanionResponse.
 *
 * Call sites: b2BypassStage, inventoryEscalationStage, clarificationGateStage.
 * (delete_sale_item_escalation is NOT included — it uses handlePermissionEscalation,
 * a completely different code path.)
 */
import type { NextResponse } from "next/server";
import {
  runSupervisor,
  supervisorAnswer,
} from "@/app/api/supervisor/_lib/supervisor-runner";
import {
  publishCompanionResponse,
  publishSupervisorQuery,
} from "@/app/api/_lib/agent-event-publishers";
import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import { bg } from "./employee-handler.ctx";
import type { LoadedBusinessAssistantContext } from "./types";

/** The subset of escalation kinds used by employee-pipeline stages. */
type EmployeeEscalationKind =
  | "B2_long_input"
  | "companion_answer_escalation"
  | "B1_clarification_loop";

export interface EscalateToSupervisorParams {
  text: string;
  lang: "en" | "es-AR";
  businessId: string;
  actorEmployeeId: string | null;
  inboundEventId: string | null;
  respond: (body: Record<string, unknown>, status?: number) => Promise<NextResponse>;
  trace: { add: (step: string, detail: string) => void; toJSON: () => Record<string, unknown> | null };
  loadedContext: LoadedBusinessAssistantContext;
  escalationKind: EmployeeEscalationKind;
  /** intent / safeIntent label written to the companion-response event. */
  intentLabel: "supervisor_bypass" | "supervisor_escalation";
  /**
   * Recent conversation turns from the employee pipeline.
   * Forwarded to runSupervisor as conversationHistory so the Supervisor can
   * resolve deictic references ("eso", "el otro producto") from prior turns.
   * Optional — when absent the Supervisor operates without history context.
   */
  conversationHistory?: ReadonlyArray<{ role: "user" | "assistant"; text: string }>;
}

/**
 * Runs the Supervisor model, fires-and-forgets the audit events, and
 * returns a NextResponse with the supervisor's answer.
 */
export async function escalateToSupervisor(
  p: EscalateToSupervisorParams,
): Promise<NextResponse> {
  // Load the supervisor context (30s cache — typically a cache hit since the owner
  // path already populated it). Provides employees + activePolicies for policy
  // enforcement during escalated employee turns. Skips onboardingState (not
  // relevant for mid-session employee escalation).
  const supCtx = await loadSupervisorContext(p.businessId);

  const supResult = await runSupervisor(p.text, {
    businessId: p.businessId,
    activeRules: p.loadedContext.context.activeRules ?? [],
    activePolicies: supCtx.activePolicies,
    employees: supCtx.employees,
    products: p.loadedContext.productInfoDirectory,
    cashBalance: p.loadedContext.context.cashBalance,
    currency: p.loadedContext.context.business.currency,
    lang: p.lang,
    conversationHistory: p.conversationHistory,
  });
  const supAnswer = supervisorAnswer(supResult, p.text).text;

  if (p.inboundEventId) {
    bg(publishSupervisorQuery({
      businessId: p.businessId,
      actorEmployeeId: p.actorEmployeeId,
      inReplyToEventId: p.inboundEventId,
      escalationKind: p.escalationKind,
      supervisorAnswer: supAnswer,
    }));
    bg(publishCompanionResponse({
      businessId: p.businessId,
      actorEmployeeId: p.actorEmployeeId,
      inReplyToEventId: p.inboundEventId,
      intent: p.intentLabel,
      safeIntent: p.intentLabel,
      answer: supAnswer,
      confidence: null,
      requiresClarification: false,
      actionsEmitted: [],
    }));
  }

  return p.respond({ answer: supAnswer, ...p.trace.toJSON() });
}
