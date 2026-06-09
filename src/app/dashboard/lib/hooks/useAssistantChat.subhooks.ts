"use client";

import { useAssistantStreaming } from "./useAssistantStreaming";
import { useAssistantActions } from "./useAssistantActions";
import type { UseAssistantChatOptions } from "./useAssistantChat.types";

/**
 * Composes the two split-off sub-hooks (`useAssistantStreaming` +
 * `useAssistantActions`) with their prop passthroughs. Extracted from
 * useAssistantChat so the main hub stays thin — this file is just the
 * wiring, no logic.
 */
export function useAssistantChatSubHooks(opts: UseAssistantChatOptions) {
  const { resolveInput } = useAssistantStreaming({
    businessId: opts.businessId,
    locale: opts.locale,
    input: opts.input,
    setInput: opts.setInput,
    loadingParse: opts.loadingParse,
    setLoadingParse: opts.setLoadingParse,
    activeInvoiceId: opts.activeInvoiceId,
    latestPurchaseRequest: opts.latestPurchaseRequest,
    chatHistory: opts.chatHistory,
    assistantConfirmationRequest: opts.assistantConfirmationRequest,
    onConfirmationConfirm: opts.onConfirmationConfirm,
    onConfirmationCancel: opts.onConfirmationCancel,
    parsed: opts.parsed,
    saleDraftInput: opts.saleDraftInput,
    setSaleDraftInput: opts.setSaleDraftInput,
    pendingSaleFlow: opts.pendingSaleFlow,
    assistantQuestionContext: opts.assistantQuestionContext,
    setAssistantQuestionContext: opts.setAssistantQuestionContext,
    setAssistantInputHint: opts.setAssistantInputHint,
    setAssistantFollowUpInput: opts.setAssistantFollowUpInput,
    setAssistantReply: opts.setAssistantReply,
    setAssistantStockDraft: opts.setAssistantStockDraft,
    setAssistantStockError: opts.setAssistantStockError,
    setAssistantConfirmationRequest: opts.setAssistantConfirmationRequest,
    setAssistantConfirmationError: opts.setAssistantConfirmationError,
    setAssistantConfirmationSubmitting: opts.setAssistantConfirmationSubmitting,
    setParseMissingField: opts.setParseMissingField,
    setCustomerSelectContext: opts.setCustomerSelectContext,
    setParseError: opts.setParseError,
    setConfirmError: opts.setConfirmError,
    setSuccessNotice: opts.setSuccessNotice,
    setInvoiceStatusNotice: opts.setInvoiceStatusNotice,
    setPurchaseActionNotice: opts.setPurchaseActionNotice,
    appendChatHistoryEntry: opts.appendChatHistoryEntry,
    appendTransientReply: opts.appendTransientReply,
    clearPendingSaleClarification: opts.clearPendingSaleClarification,
    activatePendingSaleClarification: opts.activatePendingSaleClarification,
    continuePendingSaleClarification: opts.continuePendingSaleClarification,
    getRecoverablePendingSaleFlow: opts.getRecoverablePendingSaleFlow,
    callParseSale: opts.callParseSale,
    dispatchSaleAction: opts.dispatchSaleAction,
    handleEditParsedSale: opts.handleEditParsedSale,
    setPendingSaleFlow: opts.setPendingSaleFlow,
    sendInvoiceToCustomer: opts.sendInvoiceToCustomer,
  });

  const { executeAction, handleFallbackReply, sendPurchaseRequestToSupplier } =
    useAssistantActions({
      businessId: opts.businessId,
      products: opts.products,
      clients: opts.clients,
      manufacturers: opts.manufacturers,
      latestPurchaseRequest: opts.latestPurchaseRequest,
      setAssistantReply: opts.setAssistantReply,
      setAssistantStockDraft: opts.setAssistantStockDraft,
      setCobroQrDraft: opts.setCobroQrDraft,
      setAssistantInputHint: opts.setAssistantInputHint,
      setAssistantQuestionContext: opts.setAssistantQuestionContext,
      setCustomerSelectContext: opts.setCustomerSelectContext,
      setSaleDraftInput: opts.setSaleDraftInput,
      setActiveTab: opts.setActiveTab,
      setActiveInvoiceId: opts.setActiveInvoiceId,
      setInvoiceSheetOpen: opts.setInvoiceSheetOpen,
      setInvoiceStatusNotice: opts.setInvoiceStatusNotice,
      setPurchaseActionNotice: opts.setPurchaseActionNotice,
      setLatestPurchaseRequest: opts.setLatestPurchaseRequest,
      setAssistantConfirmationRequest: opts.setAssistantConfirmationRequest,
      appendChatHistoryEntry: opts.appendChatHistoryEntry,
      appendTransientReply: opts.appendTransientReply,
      appendDurableReply: opts.appendDurableReply,
      notifyChatSuccess: opts.notifyChatSuccess,
      loadBusiness: opts.loadBusiness,
      updateProduct: opts.updateProduct,
      updateSupplierField: opts.updateSupplierField,
      updateClientField: opts.updateClientField,
      updateInvoiceStatus: opts.updateInvoiceStatus,
      downloadInvoicePdf: opts.downloadInvoicePdf,
      downloadPurchaseRequestPdf: opts.downloadPurchaseRequestPdf,
      sendInvoiceToCustomer: opts.sendInvoiceToCustomer,
      callParseSale: opts.callParseSale,
      dispatchSaleAction: opts.dispatchSaleAction,
      activatePendingSaleClarification: opts.activatePendingSaleClarification,
      t: opts.t,
    });

  return { resolveInput, executeAction, handleFallbackReply, sendPurchaseRequestToSupplier };
}
