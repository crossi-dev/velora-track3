// sale_send executor — Fast Path for "vendi X y mandale"-style turns.
// Extracted from dispatch.ts to keep that file under the 300 LOC limit and
// to isolate the LLM-fallback try/catch (otherwise a Gemini timeout bubbles
// to the route handler and surfaces as a 500 in production).

import { NextResponse } from "next/server";
import { cloudLog } from "@/lib/cloud-logger";
import { runBusinessAssistantModel } from "../model";
import { normalizeActionText } from "../shared";
import { buildModelContext } from "../filters";
import { buildLocalSaleDraft } from "./build-local-sale-draft";
import type { SaleSendIntent } from "./types";
import type { PreModelIntentParams } from "../router-params";

export async function executeSaleSend(
  intent: SaleSendIntent,
  params: PreModelIntentParams,
): Promise<NextResponse> {
  const { text, recentHistory, context } = params;
  const startedAt = Date.now();

  let matchedProductId = intent.matchedProductId;
  let matchedCustomerId = intent.matchedCustomerId;
  let productName = intent.productName;
  let resolvedBy: "deterministic" | "llm" | "partial" = "deterministic";
  let llmLatencyMs = 0;
  let llmFallbackErrored = false;

  if (intent.needsLlmFallback) {
    const llmStartedAt = Date.now();
    const saleModelContext = buildModelContext(context, false);
    try {
      const saleModelResult = await runBusinessAssistantModel(saleModelContext, text, recentHistory);
      llmLatencyMs = Date.now() - llmStartedAt;
      const saleParsed = saleModelResult.parsed;
      const llmProductName = normalizeActionText(saleParsed?.product?.name);
      const llmProductId = normalizeActionText(saleParsed?.matchedProductId) || null;
      const llmCustomerId = normalizeActionText(saleParsed?.matchedCustomerId) || null;
      matchedProductId = matchedProductId ?? llmProductId;
      matchedCustomerId = matchedCustomerId ?? llmCustomerId;
      productName = productName || llmProductName;
      resolvedBy = intent.matchedProductId || intent.matchedCustomerId ? "partial" : "llm";
    } catch (err) {
      llmLatencyMs = Date.now() - llmStartedAt;
      llmFallbackErrored = true;
      const e = err instanceof Error ? err : new Error(String(err));
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "SALE_SEND_LLM_FALLBACK_ERROR",
        a2a_transfer: false,
        message: "sale_send: LLM fallback failed, opening sale modal",
        businessId: params.businessId,
        actorEmployeeId: params.actorEmployeeId ?? undefined,
        data: {
          errMessage: e.message,
          errName: e.constructor.name,
          llmMs: llmLatencyMs,
          textLen: text.length,
        },
      });
      // Resolución parcial — mantenemos lo que el determinístico ya matcheó
      // (puede ser null/null) y dejamos que el modal client-side complete.
      resolvedBy = intent.matchedProductId || intent.matchedCustomerId ? "partial" : "deterministic";
    }
  }

  // Deterministic picker — product ambiguous: 2+ catalog entries matched with
  // close scores; return chip options so the user taps instead of the LLM guessing.
  // Ref: cloud.google.com/blog/products/ai-machine-learning/how-to-design-conversational-ai-agents
  // — "when a query is ambiguous, the agent should ask clarifying questions / offer options."
  //
  // Round-trip: chip tap calls onSendChip(value) → handleGo(value) → re-enters
  // /api/business-assistant as a new user message. The value is a natural command
  // string that re-runs detectSaleSendFastPath unambiguously: using the exact catalog
  // name scores 100 (word-boundary hit in scoreEntry), beating any runner-up by >10.
  // Mirrors the sale-payment-prompt.ts pattern — no new client-side handler needed.
  if (!matchedProductId && intent.productAmbiguous && intent.productCandidates?.length) {
    // Build "vendí {qty} {exactName} mandale wpp" — the send keyword is required for
    // detectSaleSendFastPath to fire; exact catalog name guarantees score=100 (no tie).
    const customerSuffix = intent.matchedCustomerId
      ? ` a ${params.context.catalog.customers.find((c: { id: string }) => c.id === intent.matchedCustomerId)?.name ?? "el cliente"}`
      : "";
    cloudLog({
      severity: "INFO",
      component: "SaleExecutor",
      action: "SALE_SEND_PRODUCT_PICKER",
      a2a_transfer: false,
      message: "sale_send: product ambiguous — returning deterministic picker chips",
      businessId: params.businessId,
      actorEmployeeId: params.actorEmployeeId ?? undefined,
      data: { candidateCount: intent.productCandidates.length, productName: productName || null },
    });
    return NextResponse.json({
      answer: `¿A cuál de estos productos te referís para la venta?`,
      chips: {
        kind: "single",
        options: intent.productCandidates.slice(0, 5).map((c) => ({
          label: c.name,
          value: `vendí ${intent.qty} ${c.name}${customerSuffix} mandale wpp`,
        })),
      },
    });
  }

  // Deterministic picker — customer ambiguous: 2+ catalog entries matched.
  if (matchedProductId && !matchedCustomerId && intent.customerAmbiguous && intent.customerCandidates?.length) {
    const productInCatalogForPicker = params.productInfoDirectory.find((p) => p.id === matchedProductId) ?? null;
    if (productInCatalogForPicker) {
      // Build "vendí {qty} {exactProductName} a {exactCustomerName} mandale wpp".
      // Exact customer name scores 100 (word-boundary hit), no ambiguity on re-parse.
      const resolvedProductName = productName || productInCatalogForPicker.name;
      cloudLog({
        severity: "INFO",
        component: "SaleExecutor",
        action: "SALE_SEND_CUSTOMER_PICKER",
        a2a_transfer: false,
        message: "sale_send: customer ambiguous — returning deterministic picker chips",
        businessId: params.businessId,
        actorEmployeeId: params.actorEmployeeId ?? undefined,
        data: { candidateCount: intent.customerCandidates.length, productName: productName || null },
      });
      return NextResponse.json({
        answer: `¿A cuál de estos clientes fue la venta de ${resolvedProductName || "el producto"}?`,
        chips: {
          kind: "single",
          options: intent.customerCandidates.slice(0, 5).map((c) => ({
            label: c.name,
            value: `vendí ${intent.qty} ${resolvedProductName} a ${c.name} mandale wpp`,
          })),
        },
      });
    }
  }

  // Money-path guard: reject null or hallucinated product IDs before any
  // action reaches the client. A null ID means the Fast Path + LLM both
  // failed to identify the product; a non-null ID not in the catalog means
  // the LLM invented an ID that doesn't belong to this business.
  const productInCatalog = matchedProductId
    ? params.productInfoDirectory.find((p) => p.id === matchedProductId) ?? null
    : null;

  if (!matchedProductId || !productInCatalog) {
    cloudLog({
      severity: "WARNING",
      component: "SaleExecutor",
      action: "REJECTED_HALLUCINATED_ID",
      a2a_transfer: false,
      message: "Sale rejected: matchedProductId not in catalog",
      businessId: params.businessId,
      actorEmployeeId: params.actorEmployeeId ?? undefined,
      data: {
        matchedProductId: matchedProductId ?? null,
        matchedCustomerId: matchedCustomerId ?? null,
      },
    });
    const clarification = productName
      ? `No encontré "${productName}" en el catálogo. ¿Cuál es el producto exacto?`
      : "No pude identificar el producto. ¿Cuál es el producto que querés vender?";
    return NextResponse.json({ answer: clarification });
  }

  // saleDraft local — bypasses /api/parse-sale (Vertex-dependent).
  const saleDraft = buildLocalSaleDraft({
    matchedProductId, matchedCustomerId,
    productInfo: params.productInfoDirectory,
    customers: context.catalog.customers,
    qty: intent.qty,
  });

  cloudLog({
    severity: "INFO",
    component: "System",
    action: "PRE_MODEL_SALE_SEND_HIT",
    a2a_transfer: false,
    message: "dispatcher: sale+send branch executed",
    data: {
      textLen: text.length,
      productMatched: Boolean(matchedProductId),
      customerMatched: Boolean(matchedCustomerId),
      productName: productName || null,
      resolvedBy,
      productAmbiguous: intent.productAmbiguous,
      customerAmbiguous: intent.customerAmbiguous,
      saleDraftBuilt: saleDraft !== null,
      llmFallbackErrored,
      totalMs: Date.now() - startedAt,
      llmMs: llmLatencyMs,
    },
  });

  // Employee onboarding-task tracking removed (0 rows in production, Stage 1 cleanup).

  // Plantilla determinística — nunca el answer del modelo. Modelo a veces
  // devolvía pasado ("Listo, registrada la venta...") cuando la action es
  // un intent stub esperando confirmación client-side.
  // Si el LLM fallback falló y no pudimos identificar el producto, abrimos
  // el modal client-side con un mensaje conversacional en lugar de devolver
  // 500 al usuario.
  const synthesized = productName
    ? `Registrando venta de ${productName}.`
    : llmFallbackErrored
      ? "No pude identificar el producto. Abrí el modal y completalo."
      : "Registrando venta.";
  return NextResponse.json({
    answer: synthesized,
    actions: [{
      type: "register_sale",
      matchedProductId,
      matchedCustomerId,
      autoSend: true,
    }],
    ...(saleDraft ? { saleDraft } : {}),
  });
}
