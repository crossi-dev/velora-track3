"use client";

import { useMemo, type ReactNode } from "react";
import type { DashboardState } from "./types";
import { BusinessDataContext } from "./BusinessDataContext";
import { BusinessActionsContext, type BusinessActionsContextValue } from "./BusinessActionsContext";
import { InputContext, type InputContextValue } from "./InputContext";
import { ChatContext, type ChatContextValue } from "./ChatContext";
import { UIContext, type UIContextValue } from "./UIContext";
import { QuickActionsContext, type QuickActionsContextValue } from "./QuickActionsContext";
import { useBusinessDataValue } from "./useBusinessDataValue";
import { RoleProvider, type ActorRole } from "./RoleContext";

interface DashboardProvidersProps {
  state: DashboardState;
  role: ActorRole;
  children: ReactNode;
}

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function DashboardProviders({ state, role, children }: DashboardProvidersProps) {
  const businessDataValue = useBusinessDataValue(state);

  const businessActionsValue = useMemo<BusinessActionsContextValue>(
    () => ({
      reloadData: state.reloadData,
      updateProduct: state.updateProduct,
      deleteProduct: state.deleteProduct,
      deleteClient: state.deleteClient,
      deleteSupplier: state.deleteSupplier,
      updateClientField: state.updateClientField,
      updateClientAll: state.updateClientAll,
      updateSupplierField: state.updateSupplierField,
      updateSupplierAll: state.updateSupplierAll,
      performImport: state.performImport,
      handleCuitSaved: state.handleCuitSaved,
      updateSettingsField: state.updateSettingsField,
      handleSaveSettings: state.handleSaveSettings,
      handleCreateClient: state.handleCreateClient,
      openNewClientHelper: state.openNewClientHelper,
      handleCreateSupplier: state.handleCreateSupplier,
      downloadInvoicePdf: state.downloadInvoicePdf,
      updateInvoiceStatus: state.updateInvoiceStatus,
      sendInvoiceByWhatsapp: state.sendInvoiceByWhatsapp,
      downloadPurchaseRequestPdf: state.downloadPurchaseRequestPdf,
      onProductSaved: state.onProductSaved,
      onClientSaved: state.onClientSaved,
      onSupplierSaved: state.onSupplierSaved,
      moneyFmt: state.moneyFmt,
      formatNumber: state.formatNumber,
      formatDate: state.formatDate,
      formatTime: state.formatTime,
      movementDescriptionLabel: state.movementDescriptionLabel,
      t: state.t,
      setClientDrafts: state.setClientDrafts,
      setSupplierDrafts: state.setSupplierDrafts,
      setSettingsForm: state.setSettingsForm,
      setSettingsError: state.setSettingsError,
      setSettingsNotice: state.setSettingsNotice,
      setNewClient: state.setNewClient,
      setNewSupplier: state.setNewSupplier,
      setActiveInvoiceId: state.setActiveInvoiceId,
      setInvoiceStatusNotice: state.setInvoiceStatusNotice,
    }),
    [
      state.reloadData,
      state.updateProduct,
      state.deleteProduct,
      state.deleteClient,
      state.deleteSupplier,
      state.updateClientField,
      state.updateClientAll,
      state.updateSupplierField,
      state.updateSupplierAll,
      state.performImport,
      state.handleCuitSaved,
      state.updateSettingsField,
      state.handleSaveSettings,
      state.handleCreateClient,
      state.openNewClientHelper,
      state.handleCreateSupplier,
      state.downloadInvoicePdf,
      state.updateInvoiceStatus,
      state.sendInvoiceByWhatsapp,
      state.downloadPurchaseRequestPdf,
      state.onProductSaved,
      state.onClientSaved,
      state.onSupplierSaved,
      state.moneyFmt,
      state.formatNumber,
      state.formatDate,
      state.formatTime,
      state.movementDescriptionLabel,
      state.t,
      state.setClientDrafts,
      state.setSupplierDrafts,
      state.setSettingsForm,
      state.setSettingsError,
      state.setSettingsNotice,
      state.setNewClient,
      state.setNewSupplier,
      state.setActiveInvoiceId,
      state.setInvoiceStatusNotice,
    ]
  );

  const chatValue = useMemo<ChatContextValue>(
    () => ({
      chatHistory: state.chatHistory,
      traceLoading: state.traceLoading,
      traceError: state.traceError,
      appendChatHistoryEntry: state.appendChatHistoryEntry,
      loadingParse: state.loadingParse,
      parseError: state.parseError,
      setParseError: state.setParseError,
      parseMissingField: state.parseMissingField,
      parsed: state.parsed,
      setParsed: state.setParsed,
      parsedSaleChatCount: state.parsedSaleChatCount,
      confirming: state.confirming,
      confirmError: state.confirmError,
      setConfirmError: state.setConfirmError,
      assistantReply: state.assistantReply,
      assistantStockDraft: state.assistantStockDraft,
      setAssistantStockDraft: state.setAssistantStockDraft,
      assistantStockSaving: state.assistantStockSaving,
      assistantStockError: state.assistantStockError,
      setAssistantStockError: state.setAssistantStockError,
      cobroQrDraft: state.cobroQrDraft,
      setCobroQrDraft: state.setCobroQrDraft,
      assistantConfirmationRequest: state.assistantConfirmationRequest,
      assistantConfirmationSubmitting: state.assistantConfirmationSubmitting,
      assistantConfirmationError: state.assistantConfirmationError,
      assistantQuestionContext: state.assistantQuestionContext,
      assistantInputHint: state.assistantInputHint,
      assistantFollowUpInput: state.assistantFollowUpInput,
      setAssistantFollowUpInput: state.setAssistantFollowUpInput,
      customerSelectContext: state.customerSelectContext,
      latestPurchaseRequest: state.latestPurchaseRequest,
      purchaseActionNotice: state.purchaseActionNotice,
      setPurchaseActionNotice: state.setPurchaseActionNotice,
      saleDraftRef: state.saleDraftRef,
      handleGo: state.handleGo,
      abortCurrentRequest: state.abortCurrentRequest,
      handleAssistantFollowUpSubmit: state.handleAssistantFollowUpSubmit,
      handleMissingFieldSubmit: state.handleMissingFieldSubmit,
      handleCustomerSelect: state.handleCustomerSelect,
      handleEditParsedSale: state.handleEditParsedSale,
      handleCancelParsedSale: state.handleCancelParsedSale,
      handleConfirm: state.handleConfirm,
      handleConfirmAndSendWhatsapp: state.handleConfirmAndSendWhatsapp,
      handleAssistantConfirmationConfirm: state.handleAssistantConfirmationConfirm,
      handleAssistantConfirmationCancel: state.handleAssistantConfirmationCancel,
      updateAssistantStockField: state.updateAssistantStockField,
      updateAssistantStockItem: state.updateAssistantStockItem,
      handleAssistantStockDraftDismiss: state.handleAssistantStockDraftDismiss,
      handleAssistantStockSubmit: state.handleAssistantStockSubmit,
      sendPurchaseRequestToSupplier: state.sendPurchaseRequestToSupplier,
      openSellProductHelper: state.openSellProductHelper,
    }),
    [
      state.chatHistory,
      state.traceLoading,
      state.traceError,
      state.appendChatHistoryEntry,
      state.loadingParse,
      state.parseError,
      state.setParseError,
      state.parseMissingField,
      state.parsed,
      state.setParsed,
      state.parsedSaleChatCount,
      state.confirming,
      state.confirmError,
      state.setConfirmError,
      state.assistantReply,
      state.assistantStockDraft,
      state.setAssistantStockDraft,
      state.assistantStockSaving,
      state.assistantStockError,
      state.setAssistantStockError,
      state.cobroQrDraft,
      state.setCobroQrDraft,
      state.assistantConfirmationRequest,
      state.assistantConfirmationSubmitting,
      state.assistantConfirmationError,
      state.assistantQuestionContext,
      state.assistantInputHint,
      state.assistantFollowUpInput,
      state.setAssistantFollowUpInput,
      state.customerSelectContext,
      state.latestPurchaseRequest,
      state.purchaseActionNotice,
      state.setPurchaseActionNotice,
      state.saleDraftRef,
      state.handleGo,
      state.abortCurrentRequest,
      state.handleAssistantFollowUpSubmit,
      state.handleMissingFieldSubmit,
      state.handleCustomerSelect,
      state.handleEditParsedSale,
      state.handleCancelParsedSale,
      state.handleConfirm,
      state.handleConfirmAndSendWhatsapp,
      state.handleAssistantConfirmationConfirm,
      state.handleAssistantConfirmationCancel,
      state.updateAssistantStockField,
      state.updateAssistantStockItem,
      state.handleAssistantStockDraftDismiss,
      state.handleAssistantStockSubmit,
      state.sendPurchaseRequestToSupplier,
      state.openSellProductHelper,
    ]
  );

  const uiValue = useMemo<UIContextValue>(
    () => ({
      activeTab: state.activeTab,
      setActiveTab: state.setActiveTab,
      quickAction: state.quickAction,
      setQuickAction: state.setQuickAction,
      sidebarOpen: state.sidebarOpen,
      setSidebarOpen: state.setSidebarOpen,
      successNotice: state.successNotice,
      errorNotice: state.errorNotice,
      setErrorNotice: state.setErrorNotice,
      undoAction: state.undoAction,
      setUndoAction: state.setUndoAction,
      freshInvoiceId: state.freshInvoiceId,
      setFreshInvoiceId: state.setFreshInvoiceId,
      quickActionSaving: state.quickActionSaving,
      quickActionError: state.quickActionError,
      setQuickActionError: state.setQuickActionError,
      tabLabel: state.tabLabel,
      activeSectionMeta: state.activeSectionMeta,
      dashboardQuickActions: state.dashboardQuickActions,
      invoiceSheetOpen: state.invoiceSheetOpen,
      setInvoiceSheetOpen: state.setInvoiceSheetOpen,
    }),
    [
      state.activeTab,
      state.setActiveTab,
      state.quickAction,
      state.setQuickAction,
      state.sidebarOpen,
      state.setSidebarOpen,
      state.successNotice,
      state.errorNotice,
      state.setErrorNotice,
      state.undoAction,
      state.setUndoAction,
      state.freshInvoiceId,
      state.setFreshInvoiceId,
      state.quickActionSaving,
      state.quickActionError,
      state.setQuickActionError,
      state.tabLabel,
      state.activeSectionMeta,
      state.dashboardQuickActions,
      state.invoiceSheetOpen,
      state.setInvoiceSheetOpen,
    ],
  );

  const quickActionsValue = useMemo<QuickActionsContextValue>(
    () => ({
      quickStock: state.quickStock,
      setQuickStock: state.setQuickStock,
      quickMovement: state.quickMovement,
      setQuickMovement: state.setQuickMovement,
      quickProduct: state.quickProduct,
      setQuickProduct: state.setQuickProduct,
      quickSale: state.quickSale,
      setQuickSale: state.setQuickSale,
      handleQuickStockSubmit: state.handleQuickStockSubmit,
      handleQuickMovementSubmit: state.handleQuickMovementSubmit,
      handleQuickProductSubmit: state.handleQuickProductSubmit,
      handleQuickSaleSubmit: state.handleQuickSaleSubmit,
      openQuickAction: state.openQuickAction,
    }),
    [
      state.quickStock,
      state.setQuickStock,
      state.quickMovement,
      state.setQuickMovement,
      state.quickProduct,
      state.setQuickProduct,
      state.quickSale,
      state.setQuickSale,
      state.handleQuickStockSubmit,
      state.handleQuickMovementSubmit,
      state.handleQuickProductSubmit,
      state.handleQuickSaleSubmit,
      state.openQuickAction,
    ]
  );

  const inputValue = useMemo<InputContextValue>(
    () => ({ input: state.input, setInput: state.setInput }),
    [state.input, state.setInput],
  );

  return (
    <RoleProvider role={role}>
      <BusinessDataContext.Provider value={businessDataValue}>
        <BusinessActionsContext.Provider value={businessActionsValue}>
          <InputContext.Provider value={inputValue}>
            <ChatContext.Provider value={chatValue}>
              <UIContext.Provider value={uiValue}>
                <QuickActionsContext.Provider value={quickActionsValue}>
                  {children}
                </QuickActionsContext.Provider>
              </UIContext.Provider>
            </ChatContext.Provider>
          </InputContext.Provider>
        </BusinessActionsContext.Provider>
      </BusinessDataContext.Provider>
    </RoleProvider>
  );
}
