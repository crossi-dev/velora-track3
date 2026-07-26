import { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { runSupervisor, supervisorAnswer, type OnboardingState } from "@/app/api/supervisor/_lib/supervisor-runner";
import { buildClarificationContext } from "@/lib/clarification-context-builder";
import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import { buildOwnerStages, type OwnerPipelineCtx } from "./owner-handler.stages";
import type { OwnerTurnParams } from "./owner-handler.ctx";
import type { PendingConfirmationCarrier } from "./nlu/pending-confirmation";

export type { OwnerTurnParams } from "./owner-handler.ctx";
import {
  publishSupervisorQuery,
  publishCompanionResponse,
} from "@/app/api/_lib/agent-event-publishers";
import type { LatencyTracker } from "./latency-tracker";
import { retrieveFewShotExamples } from "./few-shot-retrieval";
import { sanitizeAlertLines, sanitizeFewShotBlock } from "./owner-handler.prompt-sanitize";
import { maybeSaveFewShotExample } from "./few-shot-learner";
import { buildMemoryInjection } from "./inject-memory";
import { extractAndSaveMemory } from "./extract-memory";
import { loadBusinessAssistantContext } from "./context";
import { HIGH_RISK_ACTION_TYPES } from "./role-contract";
import { buildRiskConfirmationRequest } from "./owner-confirmation-builder";
import { deriveActivityFromActions, type AgentActivity } from "./activity-collector";
import { getMissingBusinessData, summarizeMissingData } from "./missing-business-data";
import { isVertexSearchEnabled } from "@/lib/vertex-search";
import {
  STRATEGIC_INTENTS,
  executeSupActions,
  resolveCompoundActions,
} from "./owner-handler.sup-actions";


type RespondFn = (body: Record<string, unknown>, status?: number) => Promise<NextResponse>;
type Trace = { add: (step: string, detail: string) => void; toJSON: () => Record<string, unknown> | null };
type HistoryTurn = PendingConfirmationCarrier;

function buildContextPrefix(recentHistory: HistoryTurn[]): string {
  const last = recentHistory[recentHistory.length - 1];
  if (!last || last.role !== "assistant") return "";
  return `[El asistente preguntó]: "${last.text}"\n[El dueño responde]: `;
}

// Financial confirmation gate — excessive-agency cap (Q5 strict B1).
// OWASP Secure by Default: https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html
// Default TRUE — payments require owner confirmation. SUPERVISOR_CONFIRM_FINANCIAL=false disables (demo only).
// Env var read at module load; toggling requires instance recycle.
void (function warnIfFinancialGateDisabled() {
  if (process.env.SUPERVISOR_CONFIRM_FINANCIAL === "false") {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "FINANCIAL_GATE_DISABLED",
      a2a_transfer: false,
      message: "SUPERVISOR_CONFIRM_FINANCIAL=false — financial confirmation gate is OFF. Set to true (or unset) to re-enable.",
    });
  }
})();

// Pure predicate — no side effects. Returns false only when gate is explicitly disabled.
function isFinancialConfirmationRequired(): boolean {
  return process.env.SUPERVISOR_CONFIRM_FINANCIAL !== "false";
}

// Intents that require human confirmation when the financial gate is on.
// Post-Fase-B: call_payments_agent owns the money-path (links/QR). The previous
// call_ventas_agent semantics moved to Ventas (operational catalog/stock/cash).
const FINANCIAL_SUPERVISOR_INTENTS = new Set(["call_payments_agent"]);

async function runOwnerSupervisor(
  text: string, lang: "en" | "es-AR", businessId: string, actorUserId: string,
  inboundEventId: string | null, recentHistory: HistoryTurn[],
  respond: RespondFn, trace: Trace, latency: LatencyTracker
): Promise<NextResponse> {
  latency.start("supervisor");
  const contextPrefix = buildContextPrefix(recentHistory);
  const currentTime = new Date().toLocaleString("es-AR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Argentina/Buenos_Aires" });

  // DB context + vector retrieval in parallel. few-shot is optional (fail-soft).
  // PERF-T3-2: history comes from the POST body (recentHistory), not a DB query.
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const [bizResult, fewShotResult, recentAlerts, memoryBlock] = await Promise.allSettled([
    loadSupervisorContext(businessId),
    retrieveFewShotExamples(text, "strategic"),
    prisma.chatMessage.findMany({
      where: { businessId, visibility: "owner_only", source: "manager", createdAt: { gte: todayStart } },
      select: { text: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    buildMemoryInjection(businessId, text),
  ]);
  if (bizResult.status === "rejected") throw bizResult.reason;
  const biz = bizResult.value;
  const fewShotExamples = fewShotResult.status === "fulfilled" ? sanitizeFewShotBlock(fewShotResult.value) : null;
  const alertLines = recentAlerts.status === "fulfilled"
    ? sanitizeAlertLines(recentAlerts.value)
    : "";
  const memorySection = memoryBlock.status === "fulfilled" ? memoryBlock.value : "";

  // Build conversation history from client-sent recentHistory (already available).
  // Filter out action-chip tokens — machine tokens that should never appear in
  // LLM conversation context.
  const ACTION_CHIP_PREFIXES_OWNER = ["enviar_link_pago|", "cancelar_link_pago", "cliente:", "configurar_courier:", "abrir_ajustes:", "confirm_whatsapp:"];
  const isOwnerActionChip = (t: string) => ACTION_CHIP_PREFIXES_OWNER.some((p) => p.endsWith("|") || p.endsWith(":") ? t.startsWith(p) : t.trim() === p);
  const conversationHistory: Array<{ role: "user" | "assistant"; text: string }> = recentHistory
    .filter((m) => !isOwnerActionChip(m.text))
    .map((m) => ({
      role: m.role,
      text: m.text.slice(0, 800),
    }));

  // Onboarding completion: name + payment methods set, and at least one
  // product loaded. openingCash (Fase B removed) and businessType (removed in
  // demo-scope reduction — hardcoded to "Otro" at creation) are NOT required.
  // Employees and stock policy are deferred until after the first sale.
  const setupComplete = biz.businessNameSet && biz.paymentMethodsSet;
  const onboardingComplete = setupComplete && biz.productCount > 0;
  const onboardingState: OnboardingState | undefined = onboardingComplete
    ? undefined
    : {
        productCount: biz.productCount,
        productsWithoutStock: biz.productsWithoutStock,
        employeeCount: biz.employeeCount,
        stockPolicyMissing: biz.employeeCount > 0 && !biz.activePolicies.some((p) => p.scope === "stock"),
        businessNameSet: biz.businessNameSet,
        businessTypeSet: biz.businessTypeSet,
        paymentMethodsSet: biz.paymentMethodsSet,
      };

  // Always-on: compute missing-data awareness regardless of onboarding state.
  // SupervisorBusinessContext carries the actual DB values; we map them to the
  // BusinessDataInput shape that getMissingBusinessData expects.
  // paymentProvider is not tracked in SupervisorBusinessContext (MP is async-
  // verified separately), so we omit it — alias check is the relevant signal.
  const missingDataSummary = summarizeMissingData(
    getMissingBusinessData({
      postalCode: biz.originPostalCode,
      alias: biz.transferAliasSet ? "set" : null,
      whatsappPhone: biz.whatsappPhoneSet ? "set" : null,
      cuit: biz.cuitSet ? "set" : null,
    }),
  );

  const supervisorInput = `${contextPrefix}${alertLines}${memorySection}${fewShotExamples ? `${text}${fewShotExamples}` : text}`;

  // PERF-T3-1: pre-load assistant context in parallel with the LLM call.
  // resolveCompoundActions needs fullCatalogProducts/Customers/Suppliers; loading
  // it here means the static-cache hit (or live-query fetch) runs concurrently
  // with the Supervisor instead of serially after, eliminating a ~15ms serial
  // DB round-trip when the result contains operational actions.
  const supCallStart = Date.now();
  const [supResult, preloadedAssistantCtx] = await Promise.all([
    runSupervisor(supervisorInput, {
      activeRules: biz.activeRules,
      activePolicies: biz.activePolicies,
      onboardingState,
      products: biz.products, employees: biz.employees,
      cashBalance: biz.cashBalance, currency: biz.currency,
      currentTime, ackedAlerts: biz.ackedAlerts, lang,
      originPostalCode: biz.originPostalCode ?? null,
      missingDataSummary,
      conversationHistory,
    }),
    loadBusinessAssistantContext(businessId).catch(() => null),
  ]);
  const supervisorLatencyMs = Date.now() - supCallStart;
  latency.end("supervisor");

  // Financial confirmation gate: if the gate is active and the supervisor
  // wants to call a payments agent, return a confirmation chip instead of
  // executing immediately. The owner must confirm before money moves.
  if (
    isFinancialConfirmationRequired() &&
    supResult?.kind === "actions" &&
    Array.isArray(supResult.actions) &&
    supResult.actions.some((a) => FINANCIAL_SUPERVISOR_INTENTS.has(a.intent))
  ) {
    trace.add("financial-gate", "payments action held for owner confirmation");
    const pendingMsg = supervisorAnswer(supResult).text ||
      "Voy a crear un cobro. ¿Confirmás que querés proceder?";
    return respond({
      answer: pendingMsg,
      actions: [],
      confirmationRequest: {
        id: `financial-${Date.now()}`,
        severity: "warning",
        title: "Confirmar operación financiera",
        message: pendingMsg,
        confirmLabel: "Sí, confirmar",
        cancelLabel: "Cancelar",
        action: { type: "supervisor_financial", pending: true },
      },
      ...trace.toJSON(),
    });
  }

  // Race fix (CRITICAL): executeSupActions MUTATES supResult.actions (injects Pattern C
  // intents). resolveCompoundActions READS supResult.actions. Sequential — not concurrent.
  // Clarification context (O(50) rows, ~5ms) is independent and runs in parallel.
  const [supActionsResult, clarificationCtxResolved] = await Promise.all([
    executeSupActions(supResult, businessId, actorUserId, inboundEventId, trace, text),
    supResult === null
      ? buildClarificationContext({ rawText: text, businessId })
      : Promise.resolve(undefined),
  ]);
  // resolveCompoundActions sees the fully-populated supResult.actions (post-injection).
  const compoundActions = await resolveCompoundActions(supResult, businessId, trace, preloadedAssistantCtx ?? undefined, text);
  // Override answer with enriched clarification when supResult is null.
  let supAnswer = supResult === null && clarificationCtxResolved
    ? supervisorAnswer(null, text, clarificationCtxResolved).text
    : supActionsResult.answer;

  // Derive agent activity for demo UI bubbles.
  // The vertex-search bubble is only shown when USE_VERTEX_SEARCH=true — that
  // is the necessary condition for the search_products tool to be registered on
  // the ADK agent. When the flag is off the tool is never registered, so the
  // LLM cannot invoke it and showing the bubble would be a false signal.
  const agentActivity: AgentActivity[] = [
    ...(isVertexSearchEnabled()
      ? [{ agentId: "vertex-search", agentLabel: "Vertex AI Search", icon: "🔗", action: "catálogo consultado", latencyMs: supervisorLatencyMs } as AgentActivity]
      : []),
    ...deriveActivityFromActions(supActionsResult.executedActions, supActionsResult.agentLatencyMs),
  ];

  // Fallback: supervisor emitted actions with no narration — synthesize one.
  if (!supAnswer.trim() && compoundActions.length > 0) {
    const first = compoundActions[0];
    if (first.type === "create_product") {
      const { name, price, stock } = first.product;
      supAnswer = `"${name}" creado — $${price}${stock > 0 ? ` (stock: ${stock})` : ""}.`;
    } else { supAnswer = "Hecho."; }
  }

  if (inboundEventId) {
    void publishSupervisorQuery({ businessId, actorEmployeeId: null, inReplyToEventId: inboundEventId, escalationKind: "owner_direct", supervisorAnswer: supAnswer }).catch((err) => {
      cloudLog({ severity: "WARNING", component: "System", action: "PUBLISH_SUPERVISOR_QUERY_FAILED", a2a_transfer: false, message: "publishSupervisorQuery rejected", businessId, data: { error: err instanceof Error ? err.message : String(err) } });
    });
    void publishCompanionResponse({ businessId, actorEmployeeId: null, inReplyToEventId: inboundEventId, intent: "supervisor_direct", safeIntent: "supervisor_direct", answer: supAnswer, confidence: null, requiresClarification: false, actionsEmitted: [] }).catch((err) => {
      cloudLog({ severity: "WARNING", component: "System", action: "PUBLISH_COMPANION_RESPONSE_FAILED", a2a_transfer: false, message: "publishCompanionResponse rejected", businessId, data: { error: err instanceof Error ? err.message : String(err) } });
    });
  }

  latency.setMeta("path", "owner-supervisor");
  latency.emit({ businessId, actorUserId, actorEmployeeId: null });

  if (supResult?.kind === "actions" || supResult?.kind === "answer") {
    void maybeSaveFewShotExample({ input: text, outputJson: JSON.stringify(supResult), intentType: supResult.actions?.[0]?.intent ?? supResult.kind, agentType: "strategic", confidence: 0.9, requiresClarification: false }).catch(() => { /* best-effort */ });
  }

  // Fire-and-forget: extract and persist any learned preferences from this turn.
  void extractAndSaveMemory({ ownerText: text, supervisorAnswer: supAnswer, businessId }).catch(() => { /* fail-soft */ });

  // T5: open_photo_picker → client_action; chips forwarded verbatim.
  const clientAction = supResult?.actions?.some((a) => a.intent === "open_photo_picker") ? "open_photo_picker" : undefined;
  // CRITICAL #1+#2: chips from enriched clarification context surface to UI.
  const chips = supResult?.chips
    ?? (clarificationCtxResolved ? supervisorAnswer(null, text, clarificationCtxResolved).chips : null)
    ?? null;

  const riskIndex = compoundActions.findIndex((a) => HIGH_RISK_ACTION_TYPES.has(a.type));
  if (riskIndex >= 0) {
    const confReq = buildRiskConfirmationRequest(compoundActions[riskIndex]);
    if (confReq) {
      trace.add("risk-gate", `type=${compoundActions[riskIndex].type}`);
      const safeActions = compoundActions.filter((a) => !HIGH_RISK_ACTION_TYPES.has(a.type));
      return respond({ answer: supAnswer, actions: safeActions, confirmationRequest: confReq, clientAction, chips, agentActivity, ...trace.toJSON() });
    }
  }
  return respond({ answer: supAnswer, actions: compoundActions, clientAction, chips, agentActivity, ...trace.toJSON() });
}


// Re-export for any sibling that uses STRATEGIC_INTENTS
export { STRATEGIC_INTENTS };

export async function handleOwnerTurn(params: OwnerTurnParams): Promise<NextResponse> {
  // The owner pipeline is built from the named-phase registry (see
  // pipeline-registry.ts and owner-handler.stages.ts). The supervisor LLM
  // runner is injected so stages stay free of the large closure that lives
  // here; this also keeps owner-handler.stages.ts independent of the
  // supervisor module's heavy imports.
  const ctx: OwnerPipelineCtx = { params, runSupervisor: runOwnerSupervisor };
  for (const stage of buildOwnerStages()) {
    const result = await stage.run(ctx);
    if (result !== null) return result;
  }
  throw new Error("owner pipeline exhausted without response");
}
