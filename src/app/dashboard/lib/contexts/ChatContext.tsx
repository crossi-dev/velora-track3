"use client";

import { createContext, useContext } from "react";
import type { DashboardState } from "./types";

export interface ChatContextValue {
  chatHistory: DashboardState["chatHistory"];
  traceLoading: DashboardState["traceLoading"];
  traceError: DashboardState["traceError"];
  appendChatHistoryEntry: DashboardState["appendChatHistoryEntry"];
  loadingParse: DashboardState["loadingParse"];
  parseError: DashboardState["parseError"];
  setParseError: DashboardState["setParseError"];
  parseMissingField: DashboardState["parseMissingField"];
  parsed: DashboardState["parsed"];
  setParsed: DashboardState["setParsed"];
  parsedSaleChatCount: DashboardState["parsedSaleChatCount"];
  confirming: DashboardState["confirming"];
  confirmError: DashboardState["confirmError"];
  setConfirmError: DashboardState["setConfirmError"];
  assistantReply: DashboardState["assistantReply"];
  assistantStockDraft: DashboardState["assistantStockDraft"];
  setAssistantStockDraft: DashboardState["setAssistantStockDraft"];
  assistantStockSaving: DashboardState["assistantStockSaving"];
  assistantStockError: DashboardState["assistantStockError"];
  setAssistantStockError: DashboardState["setAssistantStockError"];
  cobroQrDraft: DashboardState["cobroQrDraft"];
  setCobroQrDraft: DashboardState["setCobroQrDraft"];
  assistantConfirmationRequest: DashboardState["assistantConfirmationRequest"];
  assistantConfirmationSubmitting: DashboardState["assistantConfirmationSubmitting"];
  assistantConfirmationError: DashboardState["assistantConfirmationError"];
  assistantQuestionContext: DashboardState["assistantQuestionContext"];
  assistantInputHint: DashboardState["assistantInputHint"];
  assistantFollowUpInput: DashboardState["assistantFollowUpInput"];
  setAssistantFollowUpInput: DashboardState["setAssistantFollowUpInput"];
  customerSelectContext: DashboardState["customerSelectContext"];
  latestPurchaseRequest: DashboardState["latestPurchaseRequest"];
  purchaseActionNotice: DashboardState["purchaseActionNotice"];
  setPurchaseActionNotice: DashboardState["setPurchaseActionNotice"];
  saleDraftRef: DashboardState["saleDraftRef"];

  // Chat-related handlers
  handleGo: DashboardState["handleGo"];
  abortCurrentRequest: DashboardState["abortCurrentRequest"];
  handleAssistantFollowUpSubmit: DashboardState["handleAssistantFollowUpSubmit"];
  handleMissingFieldSubmit: DashboardState["handleMissingFieldSubmit"];
  handleCustomerSelect: DashboardState["handleCustomerSelect"];
  handleEditParsedSale: DashboardState["handleEditParsedSale"];
  handleCancelParsedSale: DashboardState["handleCancelParsedSale"];
  handleConfirm: DashboardState["handleConfirm"];
  handleConfirmAndSendWhatsapp: DashboardState["handleConfirmAndSendWhatsapp"];
  handleAssistantConfirmationConfirm: DashboardState["handleAssistantConfirmationConfirm"];
  handleAssistantConfirmationCancel: DashboardState["handleAssistantConfirmationCancel"];
  updateAssistantStockField: DashboardState["updateAssistantStockField"];
  updateAssistantStockItem: DashboardState["updateAssistantStockItem"];
  handleAssistantStockDraftDismiss: DashboardState["handleAssistantStockDraftDismiss"];
  handleAssistantStockSubmit: DashboardState["handleAssistantStockSubmit"];
  sendPurchaseRequestToSupplier: DashboardState["sendPurchaseRequestToSupplier"];
  openSellProductHelper: DashboardState["openSellProductHelper"];
}

export const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChatContext must be used within DashboardProviders");
  return ctx;
}
