"use client";

import { useState, useCallback, useRef } from "react";
import { useStockDraft } from "./useStockDraft";
import { useAssistantConfirmation } from "./useAssistantConfirmation";
import { useSaleDraftAssistant } from "./useSaleDraftAssistant";
import { useAssistantChat } from "./useAssistantChat";
import type {
  ChatHistoryEntry,
  ChipsBundle,
  CobroQrDraftState,
  FeedbackNotice,
  Product,
  ContactRow,
  InvoiceRecord,
  SaleRecord,
  PurchaseRequestRecord,
  AgentActivity,
  WidgetDescriptor,
} from "../types";

const TRANSIENT_REPLY_PREFIX = "__transient_reply__:";

interface useAssistantStateOptions {
  businessId: string | null;
  locale: string;
  businessName?: string;
  businessCurrency?: string;
  activeInvoiceId: string | null;
  latestPurchaseRequest: PurchaseRequestRecord | null;
  chatHistory?: ChatHistoryEntry[];
  products: Product[];
  clients: ContactRow[];
  manufacturers: ContactRow[];
  invoices: InvoiceRecord[];
  sales: SaleRecord[];
  currentCash: number;
  loadBusiness: (opts?: { silent?: boolean; force?: boolean }) => Promise<void>;
  setActiveTab: (tab: string) => void;
  setActiveInvoiceId: (id: string | null) => void;
  setInvoiceSheetOpen: (open: boolean) => void;
  setErrorNotice: (msg: string | null) => void;
  setSuccessNotice: (msg: string | null) => void;
  setUndoAction?: (fn: (() => Promise<void>) | null) => void;
  setFreshInvoiceId?: (id: string | null) => void;
  notifyChatSuccess?: (msg: string) => void;
  setParseError: (msg: string | null) => void;
  setConfirmError: (msg: string | null) => void;
  setQuickActionError: (msg: string | null) => void;
  setInvoiceStatusNotice: (msg: FeedbackNotice | null) => void;
  setPurchaseActionNotice: (msg: string | null) => void;
  appendChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string, chips?: ChipsBundle | null, agentActivity?: AgentActivity[]) => void;
  appendDurableChatHistoryEntry: (kind: ChatHistoryEntry["kind"], text: string, chips?: ChipsBundle | null, agentActivity?: AgentActivity[], entryId?: string, widget?: WidgetDescriptor | null) => void;
  clearStaleSaleDraftPrompt?: () => void;
  updateSupplierField: (id: string, field: string, nextValue: string, currentValue: string | null | undefined) => Promise<void>;
  updateClientField: (id: string, field: string, nextValue: string, currentValue: string | null | undefined) => Promise<void>;
  updateProduct: (id: string, patch: Partial<Product>) => Promise<void>;
  deleteProduct: (id: string) => Promise<void>;
  updateInvoiceStatus: (id: string, status: "issued" | "sent" | "paid") => Promise<void>;
  downloadInvoicePdf: (id: string, num: string) => void;
  downloadPurchaseRequestPdf: (id: string, num: string) => void;
  setLatestPurchaseRequest: (req: PurchaseRequestRecord | null) => void;
  navigateFromUserAction: (url: string) => boolean;
  refreshChatHistory?: () => void;
  moneyFmt: (n: number, currency: string, locale: string) => string;
  t: (en: string, es: string) => string;
}

export function useAssistantState(opts: useAssistantStateOptions) {
  const [input, setInput] = useState("");
  const [loadingParse, setLoadingParse] = useState(false);

  const handleGoRef = useRef<(text: string, continueAssistantQuestion?: boolean) => void | Promise<unknown>>(() => {});

  const [assistantReply, setAssistantReply] = useState<string | null>(null);
  const [assistantQuestionContext, setAssistantQuestionContext] = useState<string | null>(null);
  const [assistantInputHint, setAssistantInputHint] = useState<string | null>(null);
  const [assistantFollowUpInput, setAssistantFollowUpInput] = useState("");
  const [cobroQrDraft, setCobroQrDraft] = useState<CobroQrDraftState | null>(null);

  const { appendChatHistoryEntry, appendDurableChatHistoryEntry } = opts;

  const appendTransientReply = useCallback((text: string, agentActivity?: AgentActivity[] | null) => {
    appendChatHistoryEntry("reply", `${TRANSIENT_REPLY_PREFIX}${text}`, null, agentActivity ?? undefined);
  }, [appendChatHistoryEntry]);

  // C3: entryId pins the durable reply to the server-canonical replyClientMessageId
  // so the /api/chat-history upsert collapses the client + server writes into one row.
  const appendDurableReply = useCallback((text: string, chips?: ChipsBundle | null, agentActivity?: AgentActivity[] | null, entryId?: string, widget?: WidgetDescriptor | null) => {
    appendDurableChatHistoryEntry("reply", text, chips ?? null, agentActivity ?? undefined, entryId, widget ?? null);
  }, [appendDurableChatHistoryEntry]);

  const {
    assistantStockDraft, setAssistantStockDraft,
    assistantStockError, setAssistantStockError,
    assistantStockSaving,
    lastAssistantStockMovementIdsRef,
    updateAssistantStockItem,
    handleAssistantStockDraftDismiss,
    handleAssistantStockSubmit,
  } = useStockDraft({
    businessId: opts.businessId,
    loadBusiness: opts.loadBusiness,
    setSuccessNotice: opts.setSuccessNotice,
    setErrorNotice: opts.setErrorNotice,
    setParseError: opts.setParseError,
    setConfirmError: opts.setConfirmError,
    setInput,
    setActiveTab: opts.setActiveTab,
    setLatestPurchaseRequest: opts.setLatestPurchaseRequest,
    setPurchaseActionNotice: opts.setPurchaseActionNotice,
    setAssistantReply,
    appendChatHistoryEntry,
    notifyChatSuccess: opts.notifyChatSuccess,
  });

  const {
    assistantConfirmationRequest, setAssistantConfirmationRequest,
    assistantConfirmationError, setAssistantConfirmationError,
    assistantConfirmationSubmitting, setAssistantConfirmationSubmitting,
    draftPriceValidated, setDraftPriceValidated,
    handleAssistantConfirmationConfirm,
    handleAssistantConfirmationCancel,
  } = useAssistantConfirmation({
    products: opts.products,
    deleteProduct: opts.deleteProduct,
    loadBusiness: opts.loadBusiness,
    refreshChatHistory: opts.refreshChatHistory,
    setSuccessNotice: opts.setSuccessNotice,
    setErrorNotice: opts.setErrorNotice,
    setAssistantReply,
    appendChatHistoryEntry,
    lastAssistantStockMovementIdsRef,
    setLatestPurchaseRequest: opts.setLatestPurchaseRequest,
    t: opts.t,
  });

  const saleDraft = useSaleDraftAssistant({
    businessId: opts.businessId,
    locale: opts.locale,
    currency: opts.businessCurrency ?? "ARS",
    input,
    setInput,
    setLoadingParse,
    products: opts.products,
    clients: opts.clients,
    invoices: opts.invoices,
    assistantReply,
    setAssistantReply,
    assistantQuestionContext,
    setAssistantQuestionContext,
    assistantInputHint,
    setAssistantInputHint,
    setAssistantFollowUpInput,
    setAssistantStockDraft,
    assistantConfirmationSubmitting,
    setAssistantConfirmationSubmitting,
    loadBusiness: opts.loadBusiness,
    setActiveTab: opts.setActiveTab,
    setActiveInvoiceId: opts.setActiveInvoiceId,
    setUndoAction: opts.setUndoAction,
    setFreshInvoiceId: opts.setFreshInvoiceId,
    notifyChatSuccess: opts.notifyChatSuccess,
    setParseError: opts.setParseError,
    setConfirmError: opts.setConfirmError,
    setInvoiceStatusNotice: opts.setInvoiceStatusNotice,
    appendChatHistoryEntry,
    appendTransientReply,
    clearStaleSaleDraftPrompt: opts.clearStaleSaleDraftPrompt,
    updateProduct: opts.updateProduct,
    downloadInvoicePdf: opts.downloadInvoicePdf,
    t: opts.t,
    onHandleGo: (text: string) => { void handleGoRef.current(text); },
  });

  const chat = useAssistantChat({
    businessId: opts.businessId,
    locale: opts.locale,
    input,
    setInput,
    loadingParse,
    setLoadingParse,
    activeInvoiceId: opts.activeInvoiceId,
    latestPurchaseRequest: opts.latestPurchaseRequest,
    chatHistory: opts.chatHistory,
    products: opts.products,
    clients: opts.clients,
    manufacturers: opts.manufacturers,
    invoices: opts.invoices,
    sales: opts.sales,
    currentCash: opts.currentCash,
    businessCurrency: opts.businessCurrency ?? "ARS",
    parsed: saleDraft.parsed,
    saleDraftInput: saleDraft.saleDraftInput,
    setSaleDraftInput: saleDraft.setSaleDraftInput,
    pendingSaleFlow: saleDraft.pendingSaleFlow,
    assistantQuestionContext,
    setAssistantQuestionContext,
    setAssistantInputHint,
    setAssistantFollowUpInput,
    setAssistantReply,
    setAssistantStockDraft,
    setAssistantStockError,
    setCobroQrDraft,
    setAssistantConfirmationRequest,
    setAssistantConfirmationError,
    setAssistantConfirmationSubmitting,
    setParseMissingField: saleDraft.setParseMissingField,
    setCustomerSelectContext: saleDraft.setCustomerSelectContext,
    loadBusiness: opts.loadBusiness,
    setActiveTab: opts.setActiveTab,
    setActiveInvoiceId: opts.setActiveInvoiceId,
    setInvoiceSheetOpen: opts.setInvoiceSheetOpen,
    setSuccessNotice: opts.setSuccessNotice,
    setParseError: opts.setParseError,
    setConfirmError: opts.setConfirmError,
    setInvoiceStatusNotice: opts.setInvoiceStatusNotice,
    setPurchaseActionNotice: opts.setPurchaseActionNotice,
    appendChatHistoryEntry,
    appendTransientReply,
    appendDurableReply,
    updateProduct: opts.updateProduct,
    updateSupplierField: opts.updateSupplierField,
    updateClientField: opts.updateClientField,
    updateInvoiceStatus: opts.updateInvoiceStatus,
    downloadInvoicePdf: opts.downloadInvoicePdf,
    downloadPurchaseRequestPdf: opts.downloadPurchaseRequestPdf,
    setLatestPurchaseRequest: opts.setLatestPurchaseRequest,
    notifyChatSuccess: opts.notifyChatSuccess,
    t: opts.t,
    clearPendingSaleClarification: saleDraft.clearPendingSaleClarification,
    activatePendingSaleClarification: saleDraft.activatePendingSaleClarification,
    continuePendingSaleClarification: saleDraft.continuePendingSaleClarification,
    getRecoverablePendingSaleFlow: saleDraft.getRecoverablePendingSaleFlow,
    callParseSale: saleDraft.callParseSale,
    sendInvoiceToCustomer: saleDraft.sendInvoiceToCustomer,
    dispatchSaleAction: saleDraft.dispatchSaleAction,
    handleEditParsedSale: saleDraft.handleEditParsedSale,
    setPendingSaleFlow: saleDraft.setPendingSaleFlow,
    assistantConfirmationRequest,
    onConfirmationConfirm: handleAssistantConfirmationConfirm,
    onConfirmationCancel: handleAssistantConfirmationCancel,
  });

  handleGoRef.current = chat.handleGo;

  return {
    input, setInput,
    loadingParse, setLoadingParse,
    parsed: saleDraft.parsed, setParsed: saleDraft.setParsed,
    parsedSaleChatCount: saleDraft.parsedSaleChatCount, setParsedSaleChatCount: saleDraft.setParsedSaleChatCount,
    saleDraftInput: saleDraft.saleDraftInput, setSaleDraftInput: saleDraft.setSaleDraftInput,
    assistantReply, setAssistantReply,
    assistantQuestionContext, setAssistantQuestionContext,
    assistantInputHint, setAssistantInputHint,
    assistantFollowUpInput, setAssistantFollowUpInput,
    parseMissingField: saleDraft.parseMissingField, setParseMissingField: saleDraft.setParseMissingField,
    customerSelectContext: saleDraft.customerSelectContext, setCustomerSelectContext: saleDraft.setCustomerSelectContext,
    assistantStockDraft, setAssistantStockDraft,
    assistantStockError, setAssistantStockError,
    assistantStockSaving,
    cobroQrDraft, setCobroQrDraft,
    assistantConfirmationRequest, setAssistantConfirmationRequest,
    assistantConfirmationError, setAssistantConfirmationError,
    assistantConfirmationSubmitting, setAssistantConfirmationSubmitting,
    draftPriceValidated, setDraftPriceValidated,
    handleGo: chat.handleGo,
    abortCurrentRequest: chat.abortCurrentRequest,
    handleConfirm: saleDraft.handleConfirm,
    handleConfirmAndSendWhatsapp: saleDraft.handleConfirmAndSendWhatsapp,
    handleEditParsedSale: saleDraft.handleEditParsedSale,
    handleCancelParsedSale: saleDraft.handleCancelParsedSale,
    handleAssistantConfirmationConfirm,
    handleAssistantConfirmationCancel,
    handleMissingFieldSubmit: saleDraft.handleMissingFieldSubmit,
    handleCustomerSelect: saleDraft.handleCustomerSelect,
    updateAssistantStockItem,
    handleAssistantStockDraftDismiss,
    handleAssistantStockSubmit,
    sendPurchaseRequestToSupplier: chat.sendPurchaseRequestToSupplier,
    dispatchSaleAction: saleDraft.dispatchSaleAction,
    openSharedSaleDraft: saleDraft.openSharedSaleDraft,
    pendingSaleTextRef: saleDraft.pendingSaleTextRef,
    pendingEditRestoreRef: saleDraft.pendingEditRestoreRef,
  };
}
