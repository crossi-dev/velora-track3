"use client";

import {
  buildPendingSaleReminder,
  extractPriceFromSaleReply,
  extractQuantityFromSaleReply,
  isSaleFlowCancelCommand,
  resolvePendingCustomerReply,
  type PendingSaleFlow,
} from "../pendingSaleFlow";
import type {
  ChatHistoryEntry,
  MissingFieldHint,
  Product,
  ContactRow,
  CustomerSelectContext,
} from "../types";
import type {
  SaleOrchestrationActionKey,
  SaleOrchestrationPayload,
  SaleOrchestrationResult,
} from "../actions/contracts";
import type { CallParseSaleFn } from "./useSaleDraftParsing.api";
import { tLang } from "../DashboardLangContext";

/**
 * Dependencies for the clarification handlers. The host hook owns React state;
 * this module receives current values + setters and the parse-sale closure.
 */
export interface ClarificationDeps {
  input: string;
  saleDraftInput: string;
  setSaleDraftInput: (v: string) => void;
  pendingSaleFlow: PendingSaleFlow | null;
  parseMissingField: MissingFieldHint | null;
  setParseMissingField: (hint: MissingFieldHint | null) => void;
  customerSelectContext: CustomerSelectContext | null;
  setCustomerSelectContext: (ctx: CustomerSelectContext | null) => void;
  products: Product[];
  clients: ContactRow[];
  setLoadingParse: (v: boolean) => void;
  setParseError: (msg: string | null) => void;
  setAssistantReply: (msg: string | null) => void;
  appendTransientReply: (text: string) => void;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
  clearPendingSaleClarification: () => void;
  callParseSale: CallParseSaleFn;
  dispatchSaleAction: <K extends SaleOrchestrationActionKey>(
    action: K,
    payload: SaleOrchestrationPayload<K>
  ) => Promise<SaleOrchestrationResult<K>>;
  onHandleGo: (text: string) => void;
}

/**
 * Continues an in-flight pending sale clarification (quantity / price /
 * customer) given the user's reply. Returns true if the reply was handled.
 */
export async function continuePendingSaleClarification(
  deps: ClarificationDeps,
  replyText: string,
  flowOverride?: PendingSaleFlow | null
): Promise<boolean> {
  const {
    saleDraftInput,
    setSaleDraftInput,
    pendingSaleFlow,
    products,
    clients,
    setLoadingParse,
    setParseError,
    setAssistantReply,
    appendTransientReply,
    appendChatHistoryEntry,
    clearPendingSaleClarification,
    callParseSale,
    dispatchSaleAction,
    input,
  } = deps;

  const activePendingSaleFlow = flowOverride ?? pendingSaleFlow;
  if (!activePendingSaleFlow) return false;

  if (isSaleFlowCancelCommand(replyText)) {
    clearPendingSaleClarification();
    setAssistantReply(null);
    setParseError(null);
    return true;
  }

  if (activePendingSaleFlow.missingField === "quantity") {
    const quantity = extractQuantityFromSaleReply(replyText);
    if (!quantity) {
      const reminder = buildPendingSaleReminder(activePendingSaleFlow);
      setAssistantReply(reminder);
      appendTransientReply(reminder);
      return true;
    }

    const continuedSaleText = `${activePendingSaleFlow.saleText}\n${replyText}`;
    setSaleDraftInput(continuedSaleText);

    try {
      setLoadingParse(true);
      setParseError(null);
      const parsedResult = await callParseSale(continuedSaleText);
      if (parsedResult) {
        await dispatchSaleAction("sale.draft.open", {
          draft: parsedResult,
          source: "assistant",
        });
        const saleDetectedMsg = tLang("Sale detected. Review the draft and confirm.", "Venta detectada. Revisá el borrador y confirmá.");
        setAssistantReply(null);
        appendTransientReply(saleDetectedMsg);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : tLang("Could not continue the sale.", "No se pudo continuar la venta.");
      appendChatHistoryEntry("error", errMsg);
      setParseError(errMsg);
    } finally {
      setLoadingParse(false);
    }

    return true;
  }

  if (activePendingSaleFlow.missingField === "price") {
    const unitPrice = extractPriceFromSaleReply(replyText);
    if (!unitPrice || !activePendingSaleFlow.priceProductId) {
      const reminder = buildPendingSaleReminder(activePendingSaleFlow);
      setAssistantReply(reminder);
      appendTransientReply(reminder);
      return true;
    }

    try {
      setLoadingParse(true);
      setParseError(null);
      const baseSaleText = activePendingSaleFlow.saleText || saleDraftInput || input;
      const reparsedSale = await callParseSale(
        baseSaleText,
        undefined,
        { [activePendingSaleFlow.priceProductId]: unitPrice }
      );

      if (!reparsedSale) {
        return true;
      }

      await dispatchSaleAction("sale.draft.update", {
        draft: reparsedSale,
        source: "assistant",
      });
      setParseError(null);
      setAssistantReply(null);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : tLang("Could not continue the sale.", "No se pudo continuar la venta.");
      appendChatHistoryEntry("error", errMsg);
      setParseError(errMsg);
    } finally {
      setLoadingParse(false);
    }

    return true;
  }

  const customerResolution = resolvePendingCustomerReply(
    replyText,
    activePendingSaleFlow.saleText,
    (activePendingSaleFlow.customerOptions ?? clients).map((client) => ({ id: client.id, name: client.name })),
    products.map((product) => ({ name: product.name }))
  );

  if (customerResolution.kind === "wrong_field") {
    const reminder = buildPendingSaleReminder(activePendingSaleFlow);
    setAssistantReply(reminder);
    appendTransientReply(reminder);
    return true;
  }

  const continuationText = customerResolution.kind === "customer" && customerResolution.customer
    ? `${activePendingSaleFlow.saleText} a ${customerResolution.customer.name}`
    : `${activePendingSaleFlow.saleText}\n${replyText}`;

  setSaleDraftInput(continuationText);

  try {
    setLoadingParse(true);
    setParseError(null);
    const parsedResult = await callParseSale(
      continuationText,
      customerResolution.kind === "customer" && customerResolution.customer
        ? { matchedCustomerId: customerResolution.customer.id }
        : undefined
    );

    if (!parsedResult) {
      return true;
    }

    await dispatchSaleAction("sale.draft.open", {
      draft: parsedResult,
      source: "assistant",
    });
    setAssistantReply(null);
    const saleDetectedMsg = tLang("Sale detected. Review the draft and confirm.", "Venta detectada. Revisá el borrador y confirmá.");
    appendTransientReply(saleDetectedMsg);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : tLang("Could not continue the sale.", "No se pudo continuar la venta.");
    if (errMsg.toLowerCase().includes("cliente")) {
      setAssistantReply(errMsg);
      appendTransientReply(errMsg);
      return true;
    }
    appendChatHistoryEntry("error", errMsg);
    setParseError(errMsg);
  } finally {
    setLoadingParse(false);
  }

  return true;
}

/**
 * Handles the user submitting a missing-field value (currently: unit price)
 * via the dedicated UI input rather than the chat reply flow.
 */
export async function handleMissingFieldSubmit(
  deps: ClarificationDeps,
  value: string
): Promise<void> {
  const {
    parseMissingField,
    setParseMissingField,
    saleDraftInput,
    pendingSaleFlow,
    input,
    callParseSale,
    dispatchSaleAction,
    setParseError,
    setAssistantReply,
    appendChatHistoryEntry,
  } = deps;

  if (!parseMissingField || !parseMissingField.productId) return;
  try {
    const productName = parseMissingField.productName;
    const unitPrice = Number.parseFloat(value);

    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw new Error(tLang(`Price for "${productName}" must be greater than zero.`, `El precio para "${productName}" debe ser mayor a cero.`));
    }

    const reparsedSale = await callParseSale(
      saleDraftInput || pendingSaleFlow?.saleText || input,
      undefined,
      { [parseMissingField.productId]: unitPrice }
    );

    if (!reparsedSale) {
      return;
    }

    await dispatchSaleAction("sale.draft.update", {
      draft: reparsedSale,
      source: "assistant",
    });
    setParseMissingField(null);
    setParseError(null);
    setAssistantReply(null);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : tLang("Could not complete this action.", "No pude completar esta acción.");
    appendChatHistoryEntry("error", errMsg);
    setParseError(errMsg);
    setParseMissingField(null);
  }
}

/**
 * Handles the user picking a customer from the customer-select prompt: clears
 * the prompt and dispatches the chosen name back through the main go handler.
 */
export function handleCustomerSelect(deps: ClarificationDeps, customerName: string): void {
  const { customerSelectContext, setCustomerSelectContext, onHandleGo } = deps;
  if (!customerSelectContext) return;
  setCustomerSelectContext(null);
  onHandleGo(customerName);
}
