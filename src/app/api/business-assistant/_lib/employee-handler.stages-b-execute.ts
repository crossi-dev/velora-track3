/**
 * Execute-phase gate stages for the employee pipeline.
 * Split from stages-b.ts to keep both files under the 300-line limit.
 */
import { assessActionConfidence } from "./confidence";
import { gateIntentByRole } from "./intent-permissions";
import { rbacGuard, type RbacActorKind } from "./rbac-policy";
import { publishCompanionResponse, publishStockIngressRequest } from "@/app/api/_lib/agent-event-publishers";
import { bg, type PipelineStage } from "./employee-handler.ctx";
import { cloudLog } from "@/lib/cloud-logger";

export const confidenceGateStage: PipelineStage = {
  name: "confidenceGate",
  run: async (ctx) => {
    const {
      businessId, actorEmployeeId, inboundEventId, respond, trace,
      loadedContext: { fullCatalogProducts, fullCatalogCustomers, fullCatalogSuppliers },
    } = ctx.params;

    // Pattern B: both fields required; unexpected if absent after model stage.
    if (!ctx.safeIntent || !ctx.parsed) {
      cloudLog({ severity: "WARNING", component: "EmployeeHandler", action: "MISSING_CTX_FIELD", a2a_transfer: false, message: "MISSING_CTX_FIELD at confidenceGate", data: { stage: "confidenceGate", fields: { safeIntent: !!ctx.safeIntent, parsed: !!ctx.parsed } } });
      return null;
    }
    const { safeIntent, parsed } = ctx;

    if (safeIntent === "answer") return null;

    const confidence = assessActionConfidence(
      safeIntent, parsed, fullCatalogProducts, fullCatalogCustomers, fullCatalogSuppliers,
    );
    trace.add(
      "confidence",
      `intent=${confidence.intentConfidence} entity=${confidence.entityConfidence} self=${confidence.modelSelfReported ?? "n/a"}${confidence.reason ? ` reason=${confidence.reason}` : ""}`,
    );

    if (!confidence.needsClarification) return null;

    const confAnswer = confidence.reason
      ? `No pude completar la acción: ${confidence.reason}. ¿Podés reformularlo?`
      : "No tengo suficiente información para completar esa acción. ¿Podés darme más detalles?";

    if (inboundEventId) {
      bg(publishCompanionResponse({
        businessId, actorEmployeeId, inReplyToEventId: inboundEventId,
        intent: parsed.intent ?? safeIntent, safeIntent, answer: confAnswer,
        confidence: confidence.modelSelfReported, requiresClarification: true, actionsEmitted: [],
      }));
    }

    return respond({ answer: confAnswer, inputHint: "Ej: vendí 3 clavos a Juan", ...trace.toJSON() });
  },
};

export const rbacGateStage: PipelineStage = {
  name: "rbacGate",
  run: async (ctx) => {
    const { role, businessId, actorEmployeeId, inboundEventId, respond, cacheAndReturn, trace } = ctx.params;

    // Pattern B: both fields required; unexpected if absent after model stage.
    if (!ctx.safeIntent || !ctx.parsed) {
      cloudLog({ severity: "WARNING", component: "EmployeeHandler", action: "MISSING_CTX_FIELD", a2a_transfer: false, message: "MISSING_CTX_FIELD at rbacGate", data: { stage: "rbacGate", fields: { safeIntent: !!ctx.safeIntent, parsed: !!ctx.parsed } } });
      return null;
    }
    const { safeIntent, parsed } = ctx;

    const rbacActorKind: RbacActorKind = "employee";
    const rbacPolicyResult = rbacGuard({ kind: rbacActorKind }, safeIntent);

    if (!rbacPolicyResult.allowed) {
      trace.add("rbac-policy", `blocked intent=${safeIntent} actor=${rbacActorKind}`);
      const rbacAnswer = rbacPolicyResult.reason ?? "Esa acción la tiene que hacer el dueño.";

      if (inboundEventId) {
        bg(publishCompanionResponse({
          businessId, actorEmployeeId, inReplyToEventId: inboundEventId,
          intent: parsed.intent ?? safeIntent, safeIntent, answer: rbacAnswer,
          confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
          requiresClarification: false, actionsEmitted: ["rbac_blocked"],
        }));
      }

      return respond({ answer: rbacAnswer, ...trace.toJSON() });
    }

    const rbacBlocked = gateIntentByRole({ intent: safeIntent, role, businessId, actorEmployeeId, trace });
    if (rbacBlocked) return cacheAndReturn(rbacBlocked);

    return null;
  },
};

export const stockIngressStage: PipelineStage = {
  name: "stockIngress",
  run: async (ctx) => {
    const { businessId, actorEmployeeId, inboundEventId, respond, trace } = ctx.params;

    // Pattern B: both fields required; unexpected if absent after model stage.
    if (!ctx.safeIntent || !ctx.parsed) {
      cloudLog({ severity: "WARNING", component: "EmployeeHandler", action: "MISSING_CTX_FIELD", a2a_transfer: false, message: "MISSING_CTX_FIELD at stockIngress", data: { stage: "stockIngress", fields: { safeIntent: !!ctx.safeIntent, parsed: !!ctx.parsed } } });
      return null;
    }
    const { safeIntent, parsed } = ctx;

    if (safeIntent !== "stock_load") return null;

    const rawItems = parsed.stockDrafts ?? (parsed.stockDraft ? [parsed.stockDraft] : []);
    const items = rawItems
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map((d) => ({
        productName: typeof d.itemName === "string" ? d.itemName : "",
        quantity: typeof d.quantity === "number" ? d.quantity : Number(d.quantity ?? 1),
        unitCostPrice: typeof d.unitPrice === "number" ? d.unitPrice : Number(d.unitPrice ?? 0),
      }))
      .filter((i) => i.productName.length > 0 && i.quantity > 0);

    if (items.length === 0) {
      return respond({
        answer: "No entendí qué mercadería llegó. ¿Podés decirme el nombre del producto y la cantidad?",
        ...trace.toJSON(),
      });
    }

    const supplierRaw = parsed.stockDraft?.supplierName ?? null;
    const decision = await publishStockIngressRequest({
      businessId, actorEmployeeId, items,
      supplierName: typeof supplierRaw === "string" ? supplierRaw : null,
    });

    const chatAnswer = decision.approved && !decision.anomaly
      ? `Ingreso anotado: ${items.map((i) => `${i.quantity} ${i.productName}`).join(", ")}. El dueño lo verá reflejado en el inventario.`
      : `Avisé del ingreso, pero el dueño tiene que confirmarlo: ${decision.reason}`;

    trace.add("stock-ingress", `approved=${decision.approved} anomaly=${decision.anomaly}`);

    if (inboundEventId) {
      bg(publishCompanionResponse({
        businessId, actorEmployeeId, inReplyToEventId: inboundEventId,
        intent: "stock_load", safeIntent: "stock_load", answer: chatAnswer,
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : null,
        requiresClarification: !decision.approved,
        actionsEmitted: decision.approved ? ["stock_load"] : [],
      }));
    }

    return respond({ answer: chatAnswer, ...trace.toJSON() });
  },
};
