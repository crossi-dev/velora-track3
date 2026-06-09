import { reportWarning, cloudLog } from "@/lib/cloud-logger";
import { isB1Escalation } from "@/app/api/supervisor/_lib/supervisor-runner";
import { isWideInventoryEscalation } from "./router-escalation";
import { validateParsedAction } from "./validate-action";
import { publishCompanionResponse } from "@/app/api/_lib/agent-event-publishers";
import { logIfMissedIntent } from "./missed-intent-detector";
import { bg, type EmployeePipelineCtx, type PipelineStage } from "./employee-handler.ctx";
import { escalateToSupervisor } from "./escalate-to-supervisor";
import { redactInput } from "@/lib/redact-pii";
import { looksLikeAnalyticsQuery, buildModelContext } from "./filters";
import { runBusinessAssistantModel } from "./model";
import type { AdkToolContext } from "./model";
import { recallBusinessRules } from "@/lib/document-recall";
import { retrieveFewShotExamples } from "./few-shot-retrieval";
import { selectRelevantRule } from "./active-rules-selector";
import { buildEmployeeMemoryInjection } from "./inject-memory";
import { extractAndSaveEmployeeMemory } from "./extract-memory";

// Re-export execute-phase stages so employee-handler.stages.ts resolves from here.
export { confidenceGateStage, rbacGateStage, stockIngressStage } from "./employee-handler.stages-b-execute";
// Re-export postModelStage from its split module.
export { postModelStage } from "./employee-handler.stages-b-post";

export const inventoryEscalationStage: PipelineStage = {
  name: "inventoryEscalation",
  run: async (ctx) => {
    const { text, lang, businessId, actorEmployeeId, inboundEventId, respond, trace, loadedContext } = ctx.params;

    // Pattern A: safeIntent absent means the model stage was skipped; nothing to escalate.
    if (!ctx.safeIntent) return null;
    const safeIntent = ctx.safeIntent;

    if (
      safeIntent !== "answer" ||
      !isWideInventoryEscalation(text, loadedContext.productInfoDirectory)
    ) {
      return null;
    }

    trace.add("supervisor", "companion returned 'answer' on wide inventory query — escalating (employee)");
    return escalateToSupervisor({ text, lang, businessId, actorEmployeeId, inboundEventId, respond, trace, loadedContext, escalationKind: "companion_answer_escalation", intentLabel: "supervisor_bypass", conversationHistory: ctx.params.recentHistory });
  },
};

export const missedIntentLogStage: PipelineStage = {
  name: "missedIntentLog",
  run: async (ctx) => {
    const { text, businessId, actorEmployeeId } = ctx.params;

    // Pattern B: these fields should always be set after the model stage; log if missing.
    if (!ctx.safeIntent || !ctx.parsed || !ctx.modelResult) {
      cloudLog({ severity: "WARNING", component: "EmployeeHandler", action: "MISSING_CTX_FIELD", a2a_transfer: false, message: "MISSING_CTX_FIELD at missedIntentLog", data: { stage: "missedIntentLog", fields: { safeIntent: !!ctx.safeIntent, parsed: !!ctx.parsed, modelResult: !!ctx.modelResult } } });
      return null;
    }
    const { safeIntent, parsed, modelResult } = ctx;

    if (safeIntent === "answer") {
      logIfMissedIntent({
        text,
        modelAnswer: modelResult.answer,
        confidence: parsed.confidence,
        businessId,
        actorEmployeeId,
      });
    }
    return null;
  },
};

export const payloadValidationStage: PipelineStage = {
  name: "payloadValidation",
  run: async (ctx) => {
    const { respond, trace } = ctx.params;

    // Pattern B: both fields required for validation; unexpected if absent here.
    if (!ctx.safeIntent || !ctx.parsed) {
      cloudLog({ severity: "WARNING", component: "EmployeeHandler", action: "MISSING_CTX_FIELD", a2a_transfer: false, message: "MISSING_CTX_FIELD at payloadValidation", data: { stage: "payloadValidation", fields: { safeIntent: !!ctx.safeIntent, parsed: !!ctx.parsed } } });
      return null;
    }
    const { safeIntent, parsed } = ctx;

    const validation = validateParsedAction(safeIntent, parsed);
    if (validation.valid) return null;

    trace.add("validate", `rejected: ${validation.reason}`);
    reportWarning(`assistant.validate rejected: ${validation.reason}`, { scope: "assistant.validate", intent: safeIntent, reason: validation.reason ?? "unknown" });

    return respond({
      answer: validation.clarification!.answer,
      inputHint: validation.clarification!.inputHint,
      ...trace.toJSON(),
    });
  },
};

export const clarificationGateStage: PipelineStage = {
  name: "clarificationGate",
  run: async (ctx) => {
    const { text, lang, businessId, actorEmployeeId, inboundEventId, respond, trace, recentHistory, loadedContext } = ctx.params;

    // Pattern B: both fields required; unexpected if absent after model stage.
    if (!ctx.safeIntent || !ctx.parsed) {
      cloudLog({ severity: "WARNING", component: "EmployeeHandler", action: "MISSING_CTX_FIELD", a2a_transfer: false, message: "MISSING_CTX_FIELD at clarificationGate", data: { stage: "clarificationGate", fields: { safeIntent: !!ctx.safeIntent, parsed: !!ctx.parsed } } });
      return null;
    }
    const { safeIntent, parsed } = ctx;

    const clarificationField = parsed.clarification;
    if (
      !(
        clarificationField?.needed === true &&
        typeof clarificationField.question === "string" &&
        clarificationField.question.trim().length > 0
      )
    ) {
      return null;
    }

    if (isB1Escalation(recentHistory)) {
      trace.add("supervisor", "B1 escalation — segunda vuelta sin éxito (employee)");
      return escalateToSupervisor({ text, lang, businessId, actorEmployeeId, inboundEventId, respond, trace, loadedContext, escalationKind: "B1_clarification_loop", intentLabel: "supervisor_escalation", conversationHistory: recentHistory });
    }

    trace.add("clarification", `tier-3 model-self: ${clarificationField.question.slice(0, 80)}`);
    const bestGuess =
      typeof clarificationField.bestGuess === "string" && clarificationField.bestGuess.trim()
        ? ` (mi mejor interpretación: ${clarificationField.bestGuess.trim()})`
        : "";
    const clarifAnswer = `${clarificationField.question.trim()}${bestGuess}`;

    if (inboundEventId) {
      bg(publishCompanionResponse({
        businessId, actorEmployeeId, inReplyToEventId: inboundEventId,
        intent: parsed.intent ?? "answer", safeIntent, answer: clarifAnswer,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
        requiresClarification: true, actionsEmitted: [],
      }));
    }

    return respond({ answer: clarifAnswer, ...trace.toJSON() });
  },
};

export const modelStage: PipelineStage = {
  name: "model",
  run: async (ctx: EmployeePipelineCtx) => {
    const {
      text, lang, businessId, actorEmployeeId, recentHistory,
      latency, trace, respond, loadedContext,
    } = ctx.params;
    const { context } = loadedContext;

    const inputForAudit = text.slice(0, 200)
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
      .replace(/\b\d{6,}\b/g, "[number]");
    latency.setMeta("inputSample", inputForAudit);
    trace.add("model", "calling AI model");
    latency.start("model");

    const modelContext = buildModelContext(context, looksLikeAnalyticsQuery(text));
    const [fewShotExamples, documentContext, employeeMemoryBlock] = await Promise.all([
      retrieveFewShotExamples(text, "operational", lang),
      recallBusinessRules({ businessId, query: text }).catch(() => ""),
      // Long-term memory: retrieve relevant employee preferences/corrections.
      // Gated by USE_MEMORY_BANK — returns "" when disabled. Never throws.
      actorEmployeeId
        ? buildEmployeeMemoryInjection(businessId, actorEmployeeId, text)
        : Promise.resolve(""),
    ]);

    // 5a — reinforce relevant behavior rule: pick the single most applicable
    // rule for this turn and surface it as an explicit hint. The model already
    // has all activeRules in context; this hint makes the most relevant one
    // stand out so the Companion can mention it naturally when appropriate.
    const behaviorRules = (context.activeRules ?? []).filter((r) => r.kind === "behavior-based");
    // At this point we are pre-model — no intent has been determined yet.
    // Pass empty string so selectRelevantRule scores only on text keywords,
    // not on the literal word "answer" (which was the previous placeholder).
    const relevantRule = selectRelevantRule(behaviorRules, "", text);
    const ruleHint = relevantRule
      ? `\nREGLA RELEVANTE PARA ESTE TURNO: ${relevantRule.message}`
      : "";
    const enrichedDocContext = documentContext + ruleHint + employeeMemoryBlock;

    // Assemble ADK tool context from loadedContext so FunctionTools have
    // access to the request-scoped product directory, customers, and business
    // data. These are read-only snapshots — no shared mutable state.
    const locale = ctx.params.locale ?? "es-AR";
    const adkToolContext: AdkToolContext = {
      registerSale: {
        productDirectory: loadedContext.productInfoDirectory,
        customers: loadedContext.fullCatalogCustomers,
      },
      businessQuery: {
        productDirectory: loadedContext.productInfoDirectory,
        context,
        locale,
        business: {
          name: context.business.name,
          currency: context.business.currency,
        },
        inventorySummary: context.inventorySummary,
      },
      escalateToOwner: {
        businessId,
        actorEmployeeId: actorEmployeeId ?? null,
        // actorName resolved by the tool's caller from the actorEmployeeId
        // when needed; not pre-fetched to avoid an extra DB round-trip on
        // every employee turn.
        actorName: null,
      },
    };

    const modelResult = await runBusinessAssistantModel(
      modelContext, text, recentHistory, fewShotExamples, enrichedDocContext, lang, adkToolContext,
    );
    latency.end("model");

    // Fire-and-forget: extract and persist any learned preferences from this
    // employee turn. Only runs when memory bank is enabled and employeeId is known.
    // Never awaited — must not add latency or block the pipeline.
    if (actorEmployeeId) {
      bg(extractAndSaveEmployeeMemory({
        employeeText: text,
        companionAnswer: modelResult.answer,
        businessId,
        employeeId: actorEmployeeId,
      }));
    }

    ctx.modelResult = modelResult;

    const parsed = modelResult.parsed;
    if (!parsed) {
      trace.add("model", "parse failed — returning fallback answer");
      return respond({
        answer: modelResult.responseText || "Perdón, no entendí bien. ¿Podés reformularlo?",
        ...trace.toJSON(),
      });
    }

    ctx.parsed = parsed;
    ctx.safeIntent = modelResult.safeIntent;
    ctx.answer = modelResult.answer;

    const safeIntent = modelResult.safeIntent;
    trace.add("intent", `${safeIntent} (raw: ${parsed.intent ?? "none"})`);

    cloudLog({
      severity: "INFO",
      component: "Employee",
      action: "LLM_TURN",
      a2a_transfer: false,
      message: `intent=${safeIntent} confidence=${parsed.confidence ?? "?"}`,
      businessId,
      actorEmployeeId: actorEmployeeId ?? undefined,
      data: {
        inputText: redactInput(text, 200),
        intent: safeIntent,
        rawIntent: parsed.intent,
        confidence: parsed.confidence,
        clarificationNeeded: parsed.clarification?.needed ?? false,
      },
    });

    if (parsed.matchedProductId) trace.add("match", `product: ${parsed.matchedProductId}`);
    if (parsed.matchedCustomerId) trace.add("match", `customer: ${parsed.matchedCustomerId}`);
    if (parsed.matchedSupplierId) trace.add("match", `supplier: ${parsed.matchedSupplierId}`);

    return null;
  },
};
