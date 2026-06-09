"use client";

import { parseVeloraCommand } from "../parse-velora-command";
import { detectIncompleteIntent } from "../incomplete-intent-clarification";
import { dispatchCommandLayerIntent } from "./useAssistantChat.commandLayer";
import { buildResidualActionWarning } from "./useAssistantChat.residualAction";
import type { UseAssistantChatOptions } from "./useAssistantChat.types";

/**
 * Deterministic short-circuit que corre antes de llegar a la IA.
 *
 * Para frases que el cliente puede resolver completamente (parser de
 * comandos + clarificación de inputs incompletos conocidos), evitamos
 * el roundtrip a /api/business-assistant. Cae al fallback de IA cuando
 * el parser devuelve unmatched/compound/ambiguous-without-clarification
 * o cuando un branch del dispatcher no pudo completar.
 *
 * Devuelve `true` si el input fue manejado client-side y el caller
 * debería retornar sin invocar la IA. `false` si tiene que seguir.
 *
 * Extraído de useAssistantChat.ts para mantener ese archivo bajo el
 * ceiling de 400 LOC del CLAUDE.md "Code Size Contract".
 */
export async function tryPreAIDispatch(
  rawTextForParser: string,
  opts: UseAssistantChatOptions,
): Promise<boolean> {
  const v2 = parseVeloraCommand(rawTextForParser, opts.products, opts.clients);
  // Only "match" dispatches client-side; ambiguous/compound/no-match fall to AI.
  if (v2.kind === "ambiguous") {
    console.debug("[command-layer] ambiguous:", v2.reason, { bestGuessIntent: v2.bestGuess.intent, confidence: v2.confidence });
  }
  const command = v2.kind === "match"
    ? ({ matched: true, intent: v2.intent, data: v2.data } as Parameters<typeof dispatchCommandLayerIntent>[0])
    : null;

  if (command) {
    const handled = await dispatchCommandLayerIntent(command, rawTextForParser, {
      products: opts.products,
      clients: opts.clients,
      sales: opts.sales,
      invoices: opts.invoices,
      currentCash: opts.currentCash,
      businessCurrency: opts.businessCurrency,
      appendChatHistoryEntry: opts.appendChatHistoryEntry,
      appendDurableReply: opts.appendDurableReply,
      appendTransientReply: opts.appendTransientReply,
      setInput: opts.setInput,
      setAssistantReply: opts.setAssistantReply,
      setAssistantStockDraft: opts.setAssistantStockDraft,
      setAssistantConfirmationRequest: opts.setAssistantConfirmationRequest,
      setLoadingParse: opts.setLoadingParse,
      updateProduct: opts.updateProduct,
      loadBusiness: opts.loadBusiness,
      dispatchSaleAction: opts.dispatchSaleAction,
    });
    if (handled) {
      // Bug 2: command layer matched the FIRST intent in a multi-
      // intent message ("ingresá X y borrá Y"). The second intent
      // was silently dropped because we never reached the AI's
      // compound-action path. Surface a one-shot transient hint so
      // the user knows to re-send the second action.
      const warning = buildResidualActionWarning(rawTextForParser, command.intent);
      if (warning) opts.appendChatHistoryEntry("reply", warning);
      return true;
    }
  }

  // Pre-IA clarification: si el parser cayó a no-match y el input es
  // un verbo de acción aislado conocido (ej. "vendí" sin productos),
  // respondemos client-side con la pregunta correcta y un ejemplo —
  // sin esperar la IA. Determinístico, rápido, y enseña el formato.
  if (v2.kind === "no-match") {
    const clarification = detectIncompleteIntent(rawTextForParser);
    if (clarification) {
      opts.appendChatHistoryEntry("user", rawTextForParser);
      opts.setInput("");
      opts.setAssistantReply(clarification.message);
      opts.appendDurableReply(clarification.message);
      return true;
    }
  }

  return false;
}
