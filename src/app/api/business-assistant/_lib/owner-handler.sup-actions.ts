import { randomUUID, createHash } from "crypto";
import { executeRuleActions } from "@/app/api/supervisor/_lib/business-rule-actions";
import { executeEmployeeActions } from "@/app/api/supervisor/_lib/employee-actions";
import { executePolicyActions } from "@/app/api/supervisor/_lib/delegation-policy-actions";
import { executeBroadcastActions } from "@/app/api/supervisor/_lib/broadcast-actions";
import { executeCommunicationsActions } from "@/app/api/supervisor/_lib/communications-actions";
import { executeAgentCallActions } from "@/app/api/supervisor/_lib/agent-call-actions";
import { executeBusinessSetupActions } from "@/app/api/supervisor/_lib/business-setup-actions";
import { runSupervisor, supervisorAnswer } from "@/app/api/supervisor/_lib/supervisor-runner";
import { mapSupervisorActionsToCompoundActions } from "./supervisor-action-mapper";
import { loadBusinessAssistantContext } from "./context";

type Trace = { add: (step: string, detail: string) => void; toJSON: () => Record<string, unknown> | null };
type LoadedCtx = Awaited<ReturnType<typeof loadBusinessAssistantContext>>;

// Intents that belong to the strategic (management) domain — rules, employees,
// policies, agents. Computed once at module load; used by resolveCompoundActions
// to decide whether a supervisor result contains any operational actions that
// need compound-action mapping. Previously rebuilt on every call as `new Set(…)`.
export const STRATEGIC_INTENTS = new Set([
  "create_business_rule", "update_business_rule", "delete_business_rule",
  "create_employee", "reset_employee_pin", "get_employee_credentials",
  "create_delegation_policy", "update_delegation_policy", "delete_delegation_policy",
  "call_contador_agent", "call_ventas_agent", "call_payments_agent", "call_logistica_agent",
  // New role-agents (2026-06-03) — must be in STRATEGIC_INTENTS so resolveCompoundActions
  // does not try to map the delegation intent itself as a CompoundAction.
  "call_caja_agent", "call_inventario_agent",
  // call_communications_agent added (was missing — supervisor HIGH-1 from jd sweep).
  // Its captured Pattern C intents (send_owner_push/send_employee_push/write_owner_chat_message)
  // flow through executeCommunicationsActions, not through the compound-action mapper.
  "call_communications_agent",
  // call_equipo_agent + call_marketplace_agent SHELVED 2026-05-25.
  "update_business_setup",
  // Communications agent Pattern C intents — handled by executeCommunicationsActions,
  // not by the client-side compound-action mapper.
  "send_sms", "send_email",
  "send_owner_push", "send_employee_push", "write_owner_chat_message",
]);

export function buildSupervisorIdempotencySeed(businessId: string, actorUserId: string, inboundEventId: string | null): string {
  // El seed identifica un turno-de-supervisor; cada handler le pega su intent+index
  // adentro. Si no hay inboundEventId (e.g. flujo de import-document), usamos un
  // uuid pero ese caller debe pasar su propio seed estable.
  const seedBase = inboundEventId ?? randomUUID();
  return createHash("sha256")
    .update(`${businessId}|${actorUserId}|${seedBase}`)
    .digest("hex");
}

export async function executeSupActions(
  supResult: Awaited<ReturnType<typeof runSupervisor>>,
  businessId: string,
  actorUserId: string,
  inboundEventId: string | null,
  trace: Trace,
  rawText = "",
): Promise<{ answer: string; executedActions: Array<{ intent: string; data?: unknown }>; agentLatencyMs: number }> {
  let supAnswer = supervisorAnswer(supResult, rawText).text;

  if (supResult?.kind === "actions" && Array.isArray(supResult.actions)) {
    const seed = buildSupervisorIdempotencySeed(businessId, actorUserId, inboundEventId);

    const ruleResults = await executeRuleActions(supResult.actions, businessId, actorUserId, `${seed}|rule`);
    trace.add("rules-applied", `count=${ruleResults.totalAffected} errors=${ruleResults.errors.length}`);
    if (ruleResults.errors.length > 0) {
      supAnswer = `${ruleResults.errors.map((e) => `Error: ${e}`).join(" ")} ${supAnswer}`.trim();
    }

    const baseUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL ?? "https://www.somosvelora.com";
    const empResult = await executeEmployeeActions(supResult.actions, businessId, baseUrl, actorUserId, `${seed}|emp`);
    // Distinguish "Empleado creado" vs "PIN reseteado" vs "Credenciales" —
    // the link shape is shared across the three intents (employee-actions
    // returns {name, pin, loginUrl}; pin === null only for read-only lookup).
    // We re-derive the action kind from supResult.actions by matching the
    // link's name against the action's data.name (the user-typed name, may
    // be partial — same matching strategy as employee-actions.ts uses to
    // find the employee).
    const namesByIntent = (intent: string): string[] => supResult.actions!
      .filter((a) => a.intent === intent)
      .map((a) => {
        const d = a.data as Record<string, unknown> | null;
        return typeof d?.name === "string" ? d.name.trim().toLowerCase() : "";
      })
      .filter((n) => n.length > 0);
    const resetNames = namesByIntent("reset_employee_pin");
    const getCredNames = namesByIntent("get_employee_credentials");
    const matchesAny = (empNameLower: string, names: string[]) =>
      names.some((n) => empNameLower.includes(n) || n.includes(empNameLower));
    for (const emp of empResult.links) {
      const empNameLower = emp.name.toLowerCase();
      if (matchesAny(empNameLower, getCredNames)) {
        supAnswer += `\n\nCredenciales de ${emp.name}\nLink: ${emp.loginUrl}\nPIN: no se puede recuperar (está hasheado). Si lo perdió, pedime un reset diciendo "reseteá el pin de ${emp.name}".`;
        continue;
      }
      const isReset = matchesAny(empNameLower, resetNames);
      const header = isReset ? `PIN reseteado: ${emp.name}` : `Empleado creado: ${emp.name}`;
      supAnswer += `\n\n${header}\nLink: ${emp.loginUrl}\nPIN: ${emp.pin}`;
    }
    if (empResult.errors.length > 0) trace.add("employee-actions", `errors=${empResult.errors.join(", ")}`);

    const policyResult = await executePolicyActions(supResult.actions, businessId, actorUserId, `${seed}|policy`);
    if (policyResult.confirmations.length > 0) supAnswer = `${supAnswer} ${policyResult.confirmations.join(" ")}`.trim();
    if (policyResult.errors.length > 0) trace.add("policy-actions", `errors=${policyResult.errors.join(", ")}`);

    const broadcastResult = await executeBroadcastActions(supResult.actions, businessId, actorUserId, `${seed}|broadcast`);
    if (broadcastResult.confirmation) supAnswer = broadcastResult.confirmation;
    trace.add("broadcast", `notified=${broadcastResult.notified}`);

    // Guard: skip blind fallback if the Supervisor already delegated in-band
    // via ADK role-agent tools (call_contador_agent / call_ventas_agent / call_logistica_agent).
    // Running both would cause a duplicate A2A call and a second WhatsApp send.
    const agentCallStart = Date.now();
    let agentLatencyMs = 0;
    if (!supResult.usedAdkDelegation) {
      const agentResult = await executeAgentCallActions(supResult.actions, businessId);
      agentLatencyMs = Date.now() - agentCallStart;
      if (agentResult.confirmations.length > 0) supAnswer = `${supAnswer}\n\n${agentResult.confirmations.join("\n")}`.trim();
      if (agentResult.errors.length > 0) trace.add("agent-calls", `errors=${agentResult.errors.join(", ")}`);
      // Fase B+E strangler: inline Pattern C intents emitted by sub-agents
      // (Ventas + Equipo) into supResult.actions so resolveCompoundActions
      // and the targeted executors see them as if the supervisor had emitted
      // register_sale / create_employee / etc. directly.
      if (agentResult.capturedIntents.length > 0) {
        const captured = agentResult.capturedIntents.map((ci) => ({
          intent: ci.intent,
          data: ci.data,
          summary: ci.summary,
        }));
        supResult.actions = [...supResult.actions, ...captured];
        trace.add("agent-calls", `captured-intents=${captured.length}`);
        // NOTE: re-exec of employee/broadcast executors removed 2026-05-25 when
        // Equipo Agent was shelved. Ventas Agent's captured intents (sales /
        // catalog / stock / cash / contactos) are operational and flow through
        // resolveCompoundActions → client materialization. No per-intent
        // executor reruns are needed for those.
      }
    } else {
      agentLatencyMs = Date.now() - agentCallStart;
      // ADK in-band path: inject Pattern C intents captured from sub-agent dataParts.
      // createA2AAgentTool now extracts { intent, data, summary } from reply.dataParts
      // and pushes them into ctx.capturedPatternCIntents (shared accumulator wired in
      // supervisor-agent.ts). The field arrives here via supResult.capturedPatternCIntents.
      // This mirrors exactly what the non-ADK path does via agentResult.capturedIntents
      // (agent-call-actions.ts:121-134). Without this injection, Ventas / Communications /
      // Inventario mutations would be silently dropped on the ADK path.
      // Source: A2A Protocol v1.0 §3 — agent capabilities must propagate through the pipeline.
      // https://a2a-protocol.org/latest/specification/
      const adkCaptured = supResult.capturedPatternCIntents ?? [];
      if (adkCaptured.length > 0) {
        supResult.actions = [
          ...(supResult.actions ?? []),
          ...adkCaptured.map((ci) => ({
            intent: ci.intent,
            data: ci.data,
            summary: ci.summary,
          })),
        ];
        trace.add("agent-calls", `adk-captured-intents=${adkCaptured.length}`);
      } else {
        trace.add("agent-calls", "skipped — ADK in-band delegation already handled");
      }
    }

    // executeCommunicationsActions runs AFTER both injection blocks above so that
    // Pattern C intents captured from sub-agents (send_owner_push / send_employee_push /
    // write_owner_chat_message) — injected via agentResult.capturedIntents (non-ADK) or
    // supResult.capturedPatternCIntents (ADK) — are present in supResult.actions when
    // the executor scans them. Running it before either injection block silently dropped
    // any comms intent that arrived via agent delegation.
    //
    // Double-send prevention: two layers work in tandem.
    //   1. Recipient-dedup (executeCommunicationsActions): collapses duplicate intents
    //      targeting the SAME recipient within a single turn. This catches the direct+delegated
    //      dual-emit scenario where the Supervisor LLM emits send_owner_push directly AND
    //      call_communications_agent also returns the same logical push with DIFFERENT wording
    //      (different data → different DB idempotency hash → would fire twice without this guard).
    //   2. Per-handler idempotency (beginIdempotentMutation): guards against Supervisor
    //      retries that replay byte-identical data. It does NOT collapse same-turn dual-emit
    //      with different data — that is what recipient-dedup above handles.
    const commResult = await executeCommunicationsActions(supResult.actions, `${seed}|comm`, businessId);
    if (commResult.handled > 0) {
      trace.add("communications", `handled=${commResult.handled} errors=${commResult.errors.length}`);
    }

    const setupResult = await executeBusinessSetupActions(supResult.actions, businessId, actorUserId, `${seed}|setup`);
    trace.add("business-setup", `count=${setupResult.totalAffected} errors=${setupResult.errors.length}`);
    if (setupResult.errors.length > 0) {
      supAnswer = `${setupResult.errors.map((e) => `Error: ${e}`).join(" ")} ${supAnswer}`.trim();
    }

    return { answer: supAnswer, executedActions: supResult.actions, agentLatencyMs };
  }

  return { answer: supAnswer, executedActions: [], agentLatencyMs: 0 };
}

// PERF-T3-1: accept pre-loaded context to avoid a second loadBusinessAssistantContext
// call when the caller already loaded it in parallel with the supervisor LLM call.
// Falls back to loading fresh when preloaded is not provided.
export async function resolveCompoundActions(
  supResult: Awaited<ReturnType<typeof runSupervisor>>,
  businessId: string,
  trace: Trace,
  preloaded?: LoadedCtx,
  rawOwnerText = "",
) {
  if (!supResult?.actions?.length) return [];

  const hasOperational = supResult.actions.some((a) => !STRATEGIC_INTENTS.has(a.intent));
  if (!hasOperational) return [];

  const loaded = preloaded ?? await loadBusinessAssistantContext(businessId);
  if (!loaded) return [];

  const actions = mapSupervisorActionsToCompoundActions(
    supResult.actions,
    loaded.fullCatalogProducts,
    loaded.fullCatalogCustomers,
    loaded.fullCatalogSuppliers,
    rawOwnerText,
  );
  if (actions.length > 0) {
    trace.add("compound-actions", `mapped=${actions.length}`);
  }
  return actions;
}
