/**
 * postModelStage — final stage of the employee pipeline.
 * Split from stages-b.ts to keep both files under the 300-line limit.
 */
import { NextResponse } from "next/server";
import { handlePostModelIntents } from "./post-model-router";
import { publishCompanionResponse, publishReportEvent } from "@/app/api/_lib/agent-event-publishers";
import { createStockAvisoDraft } from "@/app/api/_lib/stock-aviso-draft";
import { maybeSaveFewShotExample } from "./few-shot-learner";
import { markOnboardingTaskDone } from "./employee-welcome";
import { bg, type PipelineStage, type EmployeePipelineCtx } from "./employee-handler.ctx";
import { cloudLog } from "@/lib/cloud-logger";

// Regex to detect when an employee performed a sales/revenue query that
// qualifies as first_sales_query onboarding task completion.
const SALES_QUERY_ONBOARDING_RE =
  /(?:^|\W)(vend[ií]|cuant[oa]\s+(?:plata|gan[eé]|fact)|cuanto\s+vend|resumen|c[oó]mo\s+(?:fue|anda|va)\s+(?:el|hoy)|caja|factur[eé])/i;

// ---------------------------------------------------------------------------
// Pattern C helper — narrows ctx when all four post-model fields are required.
// ---------------------------------------------------------------------------

type RequiredPostModelCtx = {
  safeIntent: NonNullable<EmployeePipelineCtx["safeIntent"]>;
  parsed: NonNullable<EmployeePipelineCtx["parsed"]>;
  answer: NonNullable<EmployeePipelineCtx["answer"]>;
  modelResult: NonNullable<EmployeePipelineCtx["modelResult"]>;
};

export function requirePostModelCtx(ctx: EmployeePipelineCtx): RequiredPostModelCtx | null {
  if (!ctx.safeIntent || !ctx.parsed || ctx.answer === null || !ctx.modelResult) return null;
  return {
    safeIntent: ctx.safeIntent,
    parsed: ctx.parsed,
    answer: ctx.answer,
    modelResult: ctx.modelResult,
  };
}

export const postModelStage: PipelineStage = {
  name: "postModel",
  run: async (ctx) => {
    const {
      text, locale, businessId, actorUserId, actorEmployeeId, inboundEventId,
      latency, trace, cacheAndReturn,
      loadedContext: {
        context, fullCatalogProducts, fullCatalogCustomers, fullCatalogSuppliers,
        productInfoDirectory, business,
      },
    } = ctx.params;

    // Pattern C: all four fields used multiple times throughout this stage.
    const required = requirePostModelCtx(ctx);
    if (!required) {
      cloudLog({ severity: "WARNING", component: "EmployeeHandler", action: "MISSING_CTX_FIELD", a2a_transfer: false, message: "MISSING_CTX_FIELD at postModel", data: { stage: "postModel", fields: { safeIntent: !!ctx.safeIntent, parsed: !!ctx.parsed, answer: ctx.answer !== null, modelResult: !!ctx.modelResult } } });
      return null;
    }
    const { safeIntent, parsed, answer, modelResult } = required;

    latency.start("postModel");
    latency.setMeta("path", "model");
    latency.setMeta("intent", safeIntent);
    const postModelResponse = await handlePostModelIntents({
      text, locale: locale ?? "", safeIntent, parsed, answer, context,
      fullCatalogProducts, fullCatalogCustomers, fullCatalogSuppliers,
      productInfoDirectory, trace, businessId,
      actorRole: ctx.params.role,
      actorUserId,
      actorEmployeeId,
    });
    latency.end("postModel");
    latency.emit({ businessId, actorUserId, actorEmployeeId });

    void maybeSaveFewShotExample({
      input: text,
      outputJson: modelResult.responseText,
      intentType: safeIntent,
      agentType: "operational",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      requiresClarification: parsed.clarification?.needed === true,
    }).catch(() => {});

    // Persist first_sales_query onboarding task completion — fire-and-forget.
    // Only triggered by the specific sales/summary regex — NOT by any business_query
    // (price/stock lookups are not the same as a day-summary query and would cause
    // false-positive task completion on every product price check).
    if (actorEmployeeId && SALES_QUERY_ONBOARDING_RE.test(text)) {
      void markOnboardingTaskDone(actorEmployeeId, "sales_query");
    }

    if (safeIntent === "report_event" && parsed.eventReport) {
      void publishReportEvent({
        businessId,
        actorEmployeeId,
        eventType: parsed.eventReport.eventType ?? null,
        details: parsed.eventReport.details ?? null,
        productName: parsed.eventReport.productName ?? null,
      });
    }

    if (
      safeIntent === "report_event" &&
      parsed.eventReport?.eventType === "stock_aviso" &&
      parsed.eventReport.productName
    ) {
      const productName = parsed.eventReport.productName;
      const productEntry = productInfoDirectory.find(
        (p) => p.name.toLowerCase() === productName.toLowerCase(),
      );

      if (productEntry && productEntry.stock < 5) {
        const draftResult = await createStockAvisoDraft({
          businessId,
          productName: productEntry.name,
          productId: productEntry.id,
          reorderThreshold: 5,
          supplierId: null,
          businessCurrency: business.currency,
        });

        if (draftResult.drafted) {
          trace.add("stock-aviso-draft", `drafted ${draftResult.requestNumber ?? ""}`);
          const draftSuffix = " Ya le dejé un borrador de compra al dueño para que lo apruebe.";
          const baseBody = (await postModelResponse.clone().json()) as Record<string, unknown>;
          const patchedAnswer = typeof baseBody.answer === "string"
            ? `${baseBody.answer}${draftSuffix}`
            : draftSuffix;

          if (inboundEventId) {
            bg(publishCompanionResponse({
              businessId, actorEmployeeId, inReplyToEventId: inboundEventId,
              intent: parsed.intent ?? safeIntent, safeIntent, answer: patchedAnswer,
              confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
              requiresClarification: false, actionsEmitted: [safeIntent],
            }));
          }

          // Route through cacheAndReturn so the patched reply lands in
          // scheduleReplyPersist — same gate as the normal postModel path.
          return cacheAndReturn(NextResponse.json({ ...baseBody, answer: patchedAnswer }));
        }
      }
    }

    if (inboundEventId) {
      bg(publishCompanionResponse({
        businessId, actorEmployeeId, inReplyToEventId: inboundEventId,
        intent: parsed.intent ?? safeIntent, safeIntent, answer,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
        requiresClarification: false, actionsEmitted: [safeIntent],
      }));
    }

    return cacheAndReturn(postModelResponse);
  },
};
