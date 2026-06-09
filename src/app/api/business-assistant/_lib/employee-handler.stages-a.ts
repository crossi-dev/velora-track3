import { cloudLog } from "@/lib/cloud-logger";
import {
  shouldBypassToSupervisor,
} from "@/app/api/supervisor/_lib/supervisor-runner";
import { isBusinessQuery } from "./filters";
import { buildEmployeeOnboardingResponse } from "./employee-welcome";
import { prisma } from "@/lib/prisma";
import { dispatchDeterministicIntent } from "./nlu/dispatch";
import { maybeRelabelFromConversationCorrection } from "./few-shot-learner-relabeler";
import { isPermissionRequest, handlePermissionEscalation } from "./permission-escalation";
import { runConfirmationFastPath } from "./confirmation-fast-path";
import { escalateToSupervisor } from "./escalate-to-supervisor";
import { bg, type PipelineStage } from "./employee-handler.ctx";
import { saveEmployeeNote } from "./employee-note-handler";
import { FRANCHISE_AUTH_REQUEST, isNarrativeComment } from "./franchise-guards";

// Fast Path para "sí" / "no" cuando la conversación previa abrió una
// confirmationRequest. Evita un round-trip a Gemini Flash (3-5s) cuando
// la respuesta es deterministicamente sí/no. Si el input es ambiguo
// (ej. "sí pero cambiá la cantidad"), retorna null y cae al modelo.
export const employeeConfirmationFastPathStage: PipelineStage = {
  name: "employeeConfirmationFastPath",
  run: async (ctx) => {
    const { text, recentHistory, respond, trace, latency, businessId, actorUserId, actorEmployeeId } = ctx.params;
    return runConfirmationFastPath({ text, recentHistory, respond, trace, latency, businessId, actorUserId, actorEmployeeId, role: "employee" });
  },
};

export const onboardingStage: PipelineStage = {
  name: "onboarding",
  run: async (ctx) => {
    const { actorEmployeeId, businessId, trace } = ctx.params;

    if (!actorEmployeeId) return null;

    try {
      // Fast short-circuit: if onboarding is fully done (DB flag set),
      // skip the full onboarding lookup — no criticalWriteEvent query, no
      // business context load. This runs on every request for graduated
      // employees so it must be as cheap as possible.
      const empFlag = await prisma.employee.findUnique({
        where: { id: actorEmployeeId },
        select: { onboardingCompletedAt: true },
      });
      if (empFlag?.onboardingCompletedAt) return null;

      const onboarding = await buildEmployeeOnboardingResponse({
        employeeId: actorEmployeeId,
        businessId,
      });
      if (onboarding.message) {
        ctx.onboardingPrefix = onboarding.message;
        trace.add("employee-onboarding", `task: ${onboarding.currentTask}`);
      }
    } catch (err) {
      cloudLog({
        severity: "WARNING",
        component: "Employee",
        action: "ONBOARDING_FAILED",
        a2a_transfer: false,
        message: "Employee onboarding intercept failed",
        businessId,
        data: { error: err instanceof Error ? err.message : String(err) },
      });
    }
    return null;
  },
};

export const preFilterStage: PipelineStage = {
  name: "preFilter",
  run: async (ctx) => {
    const text = ctx.params.text;
    const recentHistory = ctx.params.recentHistory;
    const contextTerms = ctx.params.loadedContext.contextTerms;
    const respond = ctx.params.respond;
    const trace = ctx.params.trace;
    const { businessId, actorEmployeeId } = ctx.params;

    const hasActiveConversation = recentHistory.length > 0;
    if (hasActiveConversation || isBusinessQuery(text, contextTerms)) return null;

    if (ctx.onboardingPrefix) {
      return respond({
        answer: ctx.onboardingPrefix,
        ...trace.toJSON(),
      });
    }

    // Franchise mode: authorization request → escalate to owner (B1).
    if (actorEmployeeId && FRANCHISE_AUTH_REQUEST.test(text)) {
      trace.add("franchise", "authorization request → B1 escalation");
      return handlePermissionEscalation({ text, businessId, actorEmployeeId, respond, trace });
    }

    // Franchise mode: narrative comment → offer to log as EmployeeNote.
    if (actorEmployeeId && isNarrativeComment(text)) {
      trace.add("franchise", "narrative comment → saving employee note");
      bg(saveEmployeeNote({ businessId, employeeId: actorEmployeeId, content: text }));
      return respond({
        answer: "Anotado. Lo paso al dueño al cierre. ¿Querés agregar algo más?",
        ...trace.toJSON(),
      });
    }

    // Small talk / unrecognized short input → brief warm reply.
    trace.add("filter", "not a business query — returning greeting");
    return respond({
      answer: "Acá estoy. Decime qué necesitás — registrá una venta, consultá stock o cargá mercadería.",
      ...trace.toJSON(),
    });
  },
};

export const b2BypassStage: PipelineStage = {
  name: "b2Bypass",
  run: async (ctx) => {
    const { text, lang, businessId, actorEmployeeId, inboundEventId, respond, trace, loadedContext, recentHistory } = ctx.params;

    if (!shouldBypassToSupervisor(text)) return null;

    trace.add("supervisor", "B2 bypass — input largo/complejo (employee)");
    return escalateToSupervisor({ text, lang, businessId, actorEmployeeId, inboundEventId, respond, trace, loadedContext, escalationKind: "B2_long_input", intentLabel: "supervisor_bypass", conversationHistory: recentHistory });
  },
};

export const permissionEscalationStage: PipelineStage = {
  name: "permissionEscalation",
  run: async (ctx) => {
    const { actorEmployeeId, text, businessId, respond, trace } = ctx.params;

    if (!actorEmployeeId || !isPermissionRequest(text)) return null;

    trace.add("permission", "employee requested permission — escalating to owner");
    return handlePermissionEscalation({ text, businessId, actorEmployeeId, respond, trace });
  },
};

export const correctionDetectStage: PipelineStage = {
  name: "correctionDetect",
  run: async (ctx) => {
    const { businessId, text, recentHistory } = ctx.params;
    bg(maybeRelabelFromConversationCorrection({ businessId, currentText: text, recentHistory }));
    return null;
  },
};

export const preModelStage: PipelineStage = {
  name: "preModel",
  run: async (ctx) => {
    const {
      text, locale, recentHistory, latency, businessId, actorUserId,
      actorEmployeeId, cacheAndReturn, role, activeInvoiceId,
      latestPurchaseRequestId, latestPurchaseRequestNumber,
      loadedContext: {
        context, business, productInfoDirectory, supplierDirectory,
        invoiceDirectory, purchaseRequestDirectory,
      },
    } = ctx.params;

    latency.start("preModel");
    const preModelResponse = await dispatchDeterministicIntent({
      text, locale: locale ?? "", recentHistory, context, business,
      productInfoDirectory, supplierDirectory, invoiceDirectory,
      purchaseRequestDirectory, activeInvoiceId, latestPurchaseRequestId,
      latestPurchaseRequestNumber, actorRole: role, businessId, actorUserId,
      actorEmployeeId,
    });
    latency.end("preModel");

    if (!preModelResponse) return null;

    latency.setMeta("path", "pre-model");
    latency.emit({ businessId, actorUserId, actorEmployeeId });

    // Never prepend the onboarding welcome/celebration prefix when the user
    // sent a concrete intent (sale, stock_query, price_query, etc.). Reaching
    // preModelStage means the input resolved to a deterministic intent — the
    // intent's own answer takes precedence. Welcome/celebration is only emitted
    // by preFilterStage, which fires exclusively for greeting/empty inputs that
    // don't resolve to any concrete intent.

    return cacheAndReturn(preModelResponse);
  },
};

// modelStage moved to employee-handler.stages-b.ts to stay within the 300-line limit.
export { modelStage } from "./employee-handler.stages-b";

// operationalQuestionStage moved to its own file to stay within the 300-line limit.
export { operationalQuestionStage } from "./employee-handler.stages-qa";
