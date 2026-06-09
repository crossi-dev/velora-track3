"use client";

import { useRef } from "react";
import { useSaleDraftParsing } from "./useSaleDraftParsing";
import { useSaleDraftExecution } from "./useSaleDraftExecution";
import { useSaleDraftConfirmation } from "./useSaleDraftConfirmation";
import type {
  ChatHistoryEntry,
  AssistantStockDraft,
  FeedbackNotice,
  Product,
  ContactRow,
  InvoiceRecord,
} from "../types";
import type {
  SaleOrchestrationActionKey,
  SaleOrchestrationPayload,
  SaleOrchestrationResult,
} from "../actions/contracts";

export interface UseSaleDraftAssistantOptions {
  businessId: string | null;
  locale: string;
  currency?: string;
  input: string;
  setInput: (value: string) => void;
  setLoadingParse: (v: boolean) => void;
  products: Product[];
  clients: ContactRow[];
  invoices: InvoiceRecord[];
  assistantReply: string | null;
  setAssistantReply: (msg: string | null) => void;
  assistantQuestionContext: string | null;
  setAssistantQuestionContext: (ctx: string | null) => void;
  assistantInputHint: string | null;
  setAssistantInputHint: (hint: string | null) => void;
  setAssistantFollowUpInput: (v: string) => void;
  setAssistantStockDraft: (draft: AssistantStockDraft | null) => void;
  assistantConfirmationSubmitting: boolean;
  setAssistantConfirmationSubmitting: (v: boolean) => void;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  setActiveTab: (tab: string) => void;
  setActiveInvoiceId: (id: string | null) => void;
  setUndoAction?: (fn: (() => Promise<void>) | null) => void;
  setFreshInvoiceId?: (id: string | null) => void;
  notifyChatSuccess?: (msg: string) => void;
  setParseError: (msg: string | null) => void;
  setConfirmError: (msg: string | null) => void;
  setInvoiceStatusNotice: (msg: FeedbackNotice | null) => void;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string) => void;
  appendTransientReply: (text: string) => void;
  clearStaleSaleDraftPrompt?: () => void;
  updateProduct: (id: string, patch: Partial<Product>) => Promise<void>;
  downloadInvoicePdf: (id: string, num: string) => void;
  t: (en: string, es: string) => string;
  onHandleGo: (text: string) => void;
}

export function useSaleDraftAssistant(opts: UseSaleDraftAssistantOptions) {
  /* ----------------------------------------------------------------
   * 1. Parsing — state, persistence, clarification, parse API
   * -------------------------------------------------------------- */

  // We need dispatchSaleAction inside parsing, but it lives in confirmation.
  // Break the cycle: parsing receives dispatchSaleAction as a callback that
  // we wire up after creating the confirmation hook via a stable ref wrapper.
  // To avoid a chicken-and-egg, we create parsing first with a temporary
  // dispatch, then replace it. However, since parsing only calls dispatch
  // inside async handlers (not during render), we can safely use a mutable
  // ref pattern. We accomplish this by passing the confirmation's dispatch
  // through the parsing hook's options. The parsing hook stores it and only
  // calls it inside event handlers, so the initial value is never invoked
  // during render.

  // Step 1: Create a placeholder dispatch that will be replaced.
  // The real one is wired after the confirmation hook is created.
  type DispatchFn = <K extends SaleOrchestrationActionKey>(
    action: K,
    payload: SaleOrchestrationPayload<K>
  ) => Promise<SaleOrchestrationResult<K>>;
  // useRef ensures the same mutable object persists across renders; a plain
  // object literal `{ current: null }` is recreated every render and any
  // async handler that captured the old ref sees stale null after a re-render.
  const dispatchRef = useRef<DispatchFn | null>(null);

  const parsing = useSaleDraftParsing({
    businessId: opts.businessId,
    locale: opts.locale,
    input: opts.input,
    setInput: opts.setInput,
    setLoadingParse: opts.setLoadingParse,
    products: opts.products,
    clients: opts.clients,
    assistantReply: opts.assistantReply,
    setAssistantReply: opts.setAssistantReply,
    assistantQuestionContext: opts.assistantQuestionContext,
    setAssistantQuestionContext: opts.setAssistantQuestionContext,
    assistantInputHint: opts.assistantInputHint,
    setAssistantInputHint: opts.setAssistantInputHint,
    setAssistantFollowUpInput: opts.setAssistantFollowUpInput,
    setParseError: opts.setParseError,
    setConfirmError: opts.setConfirmError,
    appendChatHistoryEntry: opts.appendChatHistoryEntry,
    appendTransientReply: opts.appendTransientReply,
    clearStaleSaleDraftPrompt: opts.clearStaleSaleDraftPrompt,
    onHandleGo: opts.onHandleGo,
    // The dispatch ref is captured inside async handlers only, never during render.
    dispatchSaleAction: (<K extends SaleOrchestrationActionKey>(action: K, payload: SaleOrchestrationPayload<K>) =>
      dispatchRef.current!(action, payload)) as DispatchFn,
  });

  /* ----------------------------------------------------------------
   * 2. Execution — save sale, invoice, WhatsApp
   * -------------------------------------------------------------- */

  const execution = useSaleDraftExecution({
    businessId: opts.businessId,
    locale: opts.locale,
    currency: opts.currency,
    products: opts.products,
    clients: opts.clients,
    setInput: opts.setInput,
    setUndoAction: opts.setUndoAction,
    setFreshInvoiceId: opts.setFreshInvoiceId,
    notifyChatSuccess: opts.notifyChatSuccess,
    setConfirmError: opts.setConfirmError,
    setInvoiceStatusNotice: opts.setInvoiceStatusNotice,
    appendChatHistoryEntry: opts.appendChatHistoryEntry,
    loadBusiness: opts.loadBusiness,
    downloadInvoicePdf: opts.downloadInvoicePdf,
    assistantConfirmationSubmitting: opts.assistantConfirmationSubmitting,
    setAssistantConfirmationSubmitting: opts.setAssistantConfirmationSubmitting,
    clearStaleSaleDraftPrompt: opts.clearStaleSaleDraftPrompt,
    clearSharedSaleDraft: parsing.clearSharedSaleDraft,
    getParsed: () => parsing.parsed,
    saleFlowGenRef: parsing.saleFlowGenRef,
  });

  /* ----------------------------------------------------------------
   * 3. Confirmation — dispatch, confirm, edit, cancel
   * -------------------------------------------------------------- */

  const confirmation = useSaleDraftConfirmation({
    setInput: opts.setInput,
    t: opts.t,
    appendChatHistoryEntry: opts.appendChatHistoryEntry,
    parsed: parsing.parsed,
    openSharedSaleDraft: parsing.openSharedSaleDraft,
    clearSharedSaleDraft: parsing.clearSharedSaleDraft,
    runSaleConfirmFlow: execution.runSaleConfirmFlow,
  });

  // Wire up the real dispatch so parsing's async handlers use the correct one.
  dispatchRef.current = confirmation.dispatchSaleAction;

  /* ----------------------------------------------------------------
   * 4. Return the same public API as before
   * -------------------------------------------------------------- */

  return {
    parsed: parsing.parsed,
    setParsed: parsing.setParsed,
    parsedSaleChatCount: parsing.parsedSaleChatCount,
    setParsedSaleChatCount: parsing.setParsedSaleChatCount,
    saleDraftInput: parsing.saleDraftInput,
    setSaleDraftInput: parsing.setSaleDraftInput,
    pendingSaleFlow: parsing.pendingSaleFlow,
    setPendingSaleFlow: parsing.setPendingSaleFlow,
    parseMissingField: parsing.parseMissingField,
    setParseMissingField: parsing.setParseMissingField,
    customerSelectContext: parsing.customerSelectContext,
    setCustomerSelectContext: parsing.setCustomerSelectContext,
    pendingSaleTextRef: parsing.pendingSaleTextRef,
    pendingEditRestoreRef: parsing.pendingEditRestoreRef,
    clearPendingSaleClarification: parsing.clearPendingSaleClarification,
    activatePendingSaleClarification: parsing.activatePendingSaleClarification,
    clearSharedSaleDraft: parsing.clearSharedSaleDraft,
    openSharedSaleDraft: parsing.openSharedSaleDraft,
    getRecoverablePendingSaleFlow: parsing.getRecoverablePendingSaleFlow,
    callParseSale: parsing.callParseSale,
    continuePendingSaleClarification: parsing.continuePendingSaleClarification,
    sendInvoiceToCustomer: execution.sendInvoiceToCustomer,
    dispatchSaleAction: confirmation.dispatchSaleAction,
    handleConfirm: confirmation.handleConfirm,
    handleConfirmAndSendWhatsapp: confirmation.handleConfirmAndSendWhatsapp,
    handleEditParsedSale: confirmation.handleEditParsedSale,
    handleCancelParsedSale: confirmation.handleCancelParsedSale,
    handleMissingFieldSubmit: parsing.handleMissingFieldSubmit,
    handleCustomerSelect: parsing.handleCustomerSelect,
  };
}
