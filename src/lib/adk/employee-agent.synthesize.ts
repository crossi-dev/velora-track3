// Synthesizer: tool-result → AssistantTaskModelResponse JSON string.
//
// When the ADK employee agent calls a FunctionTool, ADK's post-tool-call
// final turn returns conversational text, NOT the JSON schema the pipeline
// expects. Instead of parsing that text (which always fails), we synthesize
// the AssistantTaskModelResponse directly from the tool's execute() return
// value, captured from the function-response event in the ADK stream.
//
// Field names MUST match AssistantTaskModelResponse exactly (types.ts) AND
// must satisfy what sale-extractor.ts expects when consuming saleDraft:
//   - saleDraft.items[].productName must be a non-empty string (not null)
//   - saleDraft.customerName must be set when a customer was matched
//
// A captured tool result intentionally takes precedence over any final-text
// event. This is safe because ADK always emits the function-response event
// before the final-text event — so finalText at that point contains the
// model's conversational rephrasing (useful for display, not for parsing).

import { cloudLog } from "@/lib/cloud-logger";

export interface ToolCallResult {
  name: string;
  /** The object returned by the tool's execute() — comes from
   * event.content.parts[*].functionResponse.response */
  response: Record<string, unknown> | undefined;
}

export function synthesizeFromToolResult(toolResult: ToolCallResult): string {
  const { name, response } = toolResult;
  const r = response ?? {};

  if (name === "register_sale") {
    // Error path: product not found or validation failure.
    if (typeof r.error === "string") {
      return JSON.stringify({
        intent: "answer",
        answer: typeof r.answer === "string" ? r.answer : "No pude procesar la venta.",
        confidence: 0.5,
      });
    }

    // Success path: primaryAction contains the sale payload.
    // The register_sale tool returns:
    //   { answer, primaryAction: { type, matchedProductId, matchedCustomerId,
    //                              quantity, autoSend },
    //     resolvedProductName: string,          ← catalog-resolved name (Finding 1)
    //     resolvedCustomerName: string | null } ← catalog-resolved name (Finding 2)
    //
    // resolvedProductName is guaranteed non-null on the success path because
    // the tool only returns this object after finding productInCatalog.
    const action = r.primaryAction as
      | { type: string; matchedProductId: string; matchedCustomerId: string | null; quantity: number; autoSend: boolean }
      | undefined;

    const productName =
      typeof r.resolvedProductName === "string" && r.resolvedProductName.length > 0
        ? r.resolvedProductName
        : null;

    // Guard: resolvedProductName must be non-null on the success path.
    // If a future tool refactor drops the field, catch it here rather than
    // silently emitting productName: null which breaks downstream sale creation.
    if (productName === null) {
      cloudLog({
        severity: "ERROR",
        component: "Employee",
        action: "SYNTHESIZER_MALFORMED_REGISTER_SALE",
        a2a_transfer: false,
        message: "register_sale tool returned success shape but resolvedProductName is missing — treating as error",
        data: { toolResponse: r },
      });
      return JSON.stringify({
        intent: "answer",
        answer: "No pude procesar la venta: respuesta malformada del sistema. Intentá de nuevo.",
        confidence: 0.5,
      });
    }

    const customerName =
      typeof r.resolvedCustomerName === "string" && r.resolvedCustomerName.length > 0
        ? r.resolvedCustomerName
        : undefined; // omit when no customer so sale-extractor resolves to Consumidor Final

    return JSON.stringify({
      intent: "register_sale",
      answer: typeof r.answer === "string" ? r.answer : "Confirmar venta.",
      matchedProductId: action?.matchedProductId ?? null,
      matchedCustomerId: action?.matchedCustomerId ?? null,
      autoSend: action?.autoSend ?? false,
      confidence: 0.95,
      saleDraft: {
        ...(customerName !== undefined ? { customerName } : {}),
        items: [{ productName, quantity: action?.quantity ?? 1 }],
      },
    });
  }

  if (name === "check_stock") {
    return JSON.stringify({
      intent: "answer",
      answer: typeof r.answer === "string" ? r.answer : "No encontré datos de stock.",
      confidence: 0.9,
    });
  }

  if (name === "business_query") {
    return JSON.stringify({
      intent: "business_query",
      answer:
        typeof r.answer === "string" && r.answer
          ? r.answer
          : "No encontré datos para esa consulta.",
      confidence: 0.9,
    });
  }

  if (name === "escalate_to_owner") {
    // Tool writes the owner_only ChatMessage + push internally; synthesizer only
    // needs to produce the employee-facing acknowledgment.
    // On success the tool returns { ok: true, answer: "Le avisé al dueño…" }.
    // On error it returns { ok: false, error, answer: "No pude avisarle…" }.
    // Both paths carry a usable `answer` — use it verbatim.
    const fallbackAnswer =
      r.ok === false
        ? "No pude avisarle al dueño. Probá de nuevo."
        : "Le avisé al dueño. Te aviso cuando responda.";
    return JSON.stringify({
      intent: "answer",
      answer: typeof r.answer === "string" && r.answer ? r.answer : fallbackAnswer,
      confidence: 0.95,
    });
  }

  // Unknown tool — log at WARNING so new tools added to the ADK agent surface
  // here before a silent no-op goes to production, then fall back gracefully.
  cloudLog({
    severity: "WARNING",
    component: "Employee",
    action: "SYNTHESIZER_UNKNOWN_TOOL",
    a2a_transfer: false,
    message: `synthesizeFromToolResult received unknown tool '${name}' — add a case to employee-agent.synthesize.ts`,
    data: { toolName: name, responseKeys: Object.keys(r) },
  });
  return JSON.stringify({
    intent: "answer",
    answer: typeof r.answer === "string" ? r.answer : "No pude procesar tu solicitud.",
    confidence: 0.5,
  });
}
