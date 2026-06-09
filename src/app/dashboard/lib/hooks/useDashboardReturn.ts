"use client";

// useDashboardReturn.ts — projects the composed dashboard state into the flat
// shape consumed by DashboardState. Extracted from useDashboardHandlers.ts to
// keep that file under the 400-line frontend budget.

import type { Dispatch, SetStateAction, RefObject } from "react";
import type {
  PurchaseRequestRecord,
  QuickActionMode,
  StockMovement,
  TabKey,
} from "../types";
import type {
  resolveSelectedInvoice,
  selectedInvoiceViewFields,
} from "../hooks.analytics";
import type { useAssistantState } from "./useAssistantState";
import type { useBusinessData } from "./useBusinessData";
import type { useChatHistory } from "./useChatHistory";
import type { useContacts } from "./useContacts";
import type { useContactsUI } from "./useContactsUI";
import type { useInventory } from "./useInventory";
import type { useQuickActions } from "./useQuickActions";
import type { useSalesInvoices } from "./useSalesInvoices";
import type { useUIState } from "./useUIState";

type AssistantReturn = ReturnType<typeof useAssistantState>;
type BusinessDataReturn = ReturnType<typeof useBusinessData>;
type ChatHistoryReturn = ReturnType<typeof useChatHistory>;
type UIStateReturn = ReturnType<typeof useUIState>;
type ContactsReturn = ReturnType<typeof useContacts>;
type ContactsUIReturn = ReturnType<typeof useContactsUI>;
type InventoryReturn = ReturnType<typeof useInventory>;
type QuickActionsReturn = ReturnType<typeof useQuickActions>;
type SalesInvoicesReturn = ReturnType<typeof useSalesInvoices>;

export interface DashboardReturnContext {
  locale: string;
  activeTab: TabKey;
  setActiveTab: Dispatch<SetStateAction<TabKey>>;
  uiState: UIStateReturn;
  businessData: BusinessDataReturn;
  assistant: AssistantReturn;
  chatHistoryHook: ChatHistoryReturn;
  salesInvoices: SalesInvoicesReturn;
  contacts: ContactsReturn;
  contactsUI: ContactsUIReturn;
  inventory: InventoryReturn;
  quickActions: QuickActionsReturn;
  loadingPage: boolean;
  pageError: string | null;
  parseError: string | null;
  setParseError: Dispatch<SetStateAction<string | null>>;
  confirmError: string | null;
  setConfirmError: Dispatch<SetStateAction<string | null>>;
  successNotice: string | null;
  errorNotice: string | null;
  setErrorNotice: Dispatch<SetStateAction<string | null>>;
  undoAction: (() => Promise<void>) | null;
  // Narrowed to a plain value setter (not React's Dispatch) because the
  // hook wraps the raw useState setter to avoid the updater-fn footgun
  // that would invoke async callbacks passed as values.
  setUndoAction: (fn: (() => Promise<void>) | null) => void;
  freshInvoiceId: string | null;
  setFreshInvoiceId: Dispatch<SetStateAction<string | null>>;
  latestPurchaseRequest: PurchaseRequestRecord | null;
  purchaseActionNotice: string | null;
  setPurchaseActionNotice: Dispatch<SetStateAction<string | null>>;
  quickAction: QuickActionMode;
  setQuickAction: Dispatch<SetStateAction<QuickActionMode>>;
  quickActionError: string | null;
  setQuickActionError: Dispatch<SetStateAction<string | null>>;
  quickActionFormSaving: boolean;
  invoiceSheetOpen: boolean;
  setInvoiceSheetOpen: Dispatch<SetStateAction<boolean>>;
  saleDraftRef: RefObject<HTMLDivElement | null>;
  currentCash: number;
  totalIncome: number;
  totalExpense: number;
  inventoryChanges: StockMovement[];
  selectedInvoice: ReturnType<typeof resolveSelectedInvoice>;
  latestPurchaseRequestPayload: PurchaseRequestRecord["payload"] | undefined;
  selectedInvoiceBusiness: ReturnType<typeof selectedInvoiceViewFields>["selectedInvoiceBusiness"];
  selectedInvoiceCustomer: ReturnType<typeof selectedInvoiceViewFields>["selectedInvoiceCustomer"];
  selectedInvoiceSale: ReturnType<typeof selectedInvoiceViewFields>["selectedInvoiceSale"];
  tabLabel: (tab: TabKey) => string;
  activeSectionMeta: { eyebrow: string; title: string; description: string } | null;
  dashboardQuickActions: Array<{ key: string; title: string; example: string }>;
  performImport: (
    type: "products" | "customers" | "suppliers",
    file: File
  ) => Promise<{ imported: number; skipped?: number }>;
  t: (en: string, es: string) => string;
}

/**
 * Projects the composed dashboard state (sub-hooks, local state, derived
 * values, handlers) into the flat shape consumed by `DashboardState`.
 * Moved out of `useDashboardHandlers.ts` to keep the main hub focused on
 * handler composition — the return object was ~160 LOC of pure key: value
 * plumbing that doesn't belong alongside handler logic.
 */
export function buildDashboardReturn(ctx: DashboardReturnContext) {
  const { assistant, businessData, chatHistoryHook, salesInvoices, contacts, contactsUI, inventory, quickActions, uiState } = ctx;
  return {
    locale: ctx.locale,
    activeTab: ctx.activeTab, setActiveTab: ctx.setActiveTab,
    sidebarOpen: uiState.sidebarOpen,
    setSidebarOpen: uiState.setSidebarOpen,
    invoiceSheetOpen: ctx.invoiceSheetOpen,
    setInvoiceSheetOpen: ctx.setInvoiceSheetOpen,
    business: businessData.business,
    employeeName: businessData.employeeName,
    products: businessData.products,
    clients: businessData.clients,
    clientDrafts: contacts.clientDrafts,
    setClientDrafts: contacts.setClientDrafts,
    manufacturers: businessData.manufacturers,
    supplierDrafts: contacts.supplierDrafts,
    setSupplierDrafts: contacts.setSupplierDrafts,
    sales: businessData.sales,
    cashMovements: businessData.cashMovements,
    invoices: businessData.invoices,
    activeInvoiceId: salesInvoices.activeInvoiceId,
    setActiveInvoiceId: salesInvoices.setActiveInvoiceId,
    invoiceStatusNotice: salesInvoices.invoiceStatusNotice,
    setInvoiceStatusNotice: salesInvoices.setInvoiceStatusNotice,
    settingsForm: businessData.settingsForm,
    setSettingsForm: businessData.setSettingsForm,
    settingsSaving: businessData.loadingSettings,
    settingsError: businessData.settingsError,
    setSettingsError: businessData.setSettingsError,
    settingsNotice: businessData.settingsNotice,
    setSettingsNotice: businessData.setSettingsNotice,
    savedProductId: uiState.savedProductId,
    onProductSaved: (id: string) => uiState.flashSaved(uiState.setSavedProductId, id),
    savedClientId: uiState.savedClientId,
    onClientSaved: (id: string) => uiState.flashSaved(uiState.setSavedClientId, id),
    savedSupplierId: uiState.savedSupplierId,
    onSupplierSaved: (id: string) => uiState.flashSaved(uiState.setSavedSupplierId, id),
    downloadingInvoiceId: uiState.downloadingInvoiceId,
    downloadingPurchaseRequestId: uiState.downloadingPurchaseRequestId,
    loadingPage: ctx.loadingPage,
    pageError: ctx.pageError,
    input: assistant.input,
    setInput: assistant.setInput,
    saleDraftRef: ctx.saleDraftRef,
    chatHistory: chatHistoryHook.chatHistory,
    traceLoading: chatHistoryHook.traceLoading,
    traceError: chatHistoryHook.traceError,
    appendChatHistoryEntry: chatHistoryHook.appendChatHistoryEntry,
    refreshChatHistory: chatHistoryHook.refreshChatHistory,
    loadingParse: assistant.loadingParse,
    parseError: ctx.parseError,
    setParseError: ctx.setParseError,
    parseMissingField: assistant.parseMissingField,
    parsed: assistant.parsed,
    setParsed: assistant.setParsed,
    parsedSaleChatCount: assistant.parsedSaleChatCount,
    confirming: assistant.assistantConfirmationSubmitting || !assistant.draftPriceValidated,
    confirmError: ctx.confirmError,
    setConfirmError: ctx.setConfirmError,
    successNotice: ctx.successNotice,
    undoAction: ctx.undoAction,
    setUndoAction: ctx.setUndoAction,
    freshInvoiceId: ctx.freshInvoiceId,
    setFreshInvoiceId: ctx.setFreshInvoiceId,
    errorNotice: ctx.errorNotice,
    setErrorNotice: ctx.setErrorNotice,
    assistantReply: assistant.assistantReply,
    assistantStockDraft: assistant.assistantStockDraft,
    setAssistantStockDraft: assistant.setAssistantStockDraft,
    assistantStockSaving: assistant.assistantStockSaving,
    assistantStockError: assistant.assistantStockError,
    setAssistantStockError: assistant.setAssistantStockError,
    cobroQrDraft: assistant.cobroQrDraft,
    setCobroQrDraft: assistant.setCobroQrDraft,
    assistantConfirmationRequest: assistant.assistantConfirmationRequest,
    assistantConfirmationSubmitting: assistant.assistantConfirmationSubmitting,
    assistantConfirmationError: assistant.assistantConfirmationError,
    assistantQuestionContext: assistant.assistantQuestionContext,
    assistantInputHint: assistant.assistantInputHint,
    assistantFollowUpInput: assistant.assistantFollowUpInput,
    setAssistantFollowUpInput: assistant.setAssistantFollowUpInput,
    customerSelectContext: assistant.customerSelectContext,
    latestPurchaseRequest: ctx.latestPurchaseRequest,
    purchaseActionNotice: ctx.purchaseActionNotice,
    setPurchaseActionNotice: ctx.setPurchaseActionNotice,
    notifications: businessData.notifications,
    quickAction: ctx.quickAction,
    setQuickAction: ctx.setQuickAction,
    // Only the quick-action form's OWN saving flag (resets in its handler's
    // finally). Previously OR'd with businessData.loadingSettings +
    // assistant.assistantStockSaving — unrelated global flags that, when stuck
    // true, froze the New Product / New Stock button on "Guardando..." forever.
    quickActionSaving: ctx.quickActionFormSaving,
    quickActionError: ctx.quickActionError,
    setQuickActionError: ctx.setQuickActionError,
    quickStock: quickActions.quickStock,
    setQuickStock: quickActions.setQuickStock,
    quickMovement: quickActions.quickMovement,
    setQuickMovement: quickActions.setQuickMovement,
    quickProduct: quickActions.quickProduct,
    setQuickProduct: quickActions.setQuickProduct,
    quickSale: quickActions.quickSale,
    setQuickSale: quickActions.setQuickSale,
    lastUpdated: businessData.lastUpdated,
    t: ctx.t,
    newClient: contactsUI.newClient,
    setNewClient: contactsUI.setNewClient,
    newClientSheetRequestId: contactsUI.newClientSheetRequestId,
    clientSaving: contactsUI.clientSaving,
    clientError: contactsUI.clientError,
    clientNotice: contactsUI.clientNotice,
    handleCreateClient: contactsUI.handleCreateClient,
    openNewClientHelper: contactsUI.openNewClientHelper,
    newSupplier: contactsUI.newSupplier,
    setNewSupplier: contactsUI.setNewSupplier,
    supplierSaving: contactsUI.supplierSaving,
    supplierError: contactsUI.supplierError,
    supplierNotice: contactsUI.supplierNotice,
    handleCreateSupplier: contactsUI.handleCreateSupplier,
    performImport: ctx.performImport,
    currentCash: ctx.currentCash,
    totalIncome: ctx.totalIncome,
    totalExpense: ctx.totalExpense,
    inventoryChanges: ctx.inventoryChanges,
    selectedInvoice: ctx.selectedInvoice,
    latestPurchaseRequestPayload: ctx.latestPurchaseRequestPayload,
    selectedInvoiceBusiness: ctx.selectedInvoiceBusiness,
    selectedInvoiceCustomer: ctx.selectedInvoiceCustomer,
    selectedInvoiceSale: ctx.selectedInvoiceSale,
    tabLabel: ctx.tabLabel,
    activeSectionMeta: ctx.activeSectionMeta,
    dashboardQuickActions: ctx.dashboardQuickActions,
    handleQuickStockSubmit: quickActions.handleQuickStockSubmit,
    handleQuickMovementSubmit: quickActions.handleQuickMovementSubmit,
    handleQuickProductSubmit: quickActions.handleQuickProductSubmit,
    handleQuickSaleSubmit: quickActions.handleQuickSaleSubmit,
    abortCurrentRequest: assistant.abortCurrentRequest,
    handleMissingFieldSubmit: assistant.handleMissingFieldSubmit,
    handleCustomerSelect: assistant.handleCustomerSelect,
    handleEditParsedSale: assistant.handleEditParsedSale,
    handleCancelParsedSale: assistant.handleCancelParsedSale,
    handleConfirm: assistant.handleConfirm,
    handleConfirmAndSendWhatsapp: assistant.handleConfirmAndSendWhatsapp,
    handleAssistantConfirmationConfirm: assistant.handleAssistantConfirmationConfirm,
    handleAssistantConfirmationCancel: assistant.handleAssistantConfirmationCancel,
    updateInvoiceStatus: salesInvoices.updateInvoiceStatus,
    updateAssistantStockItem: assistant.updateAssistantStockItem,
    handleAssistantStockDraftDismiss: assistant.handleAssistantStockDraftDismiss,
    handleAssistantStockSubmit: assistant.handleAssistantStockSubmit,
    updateProduct: inventory.updateProduct,
    deleteProduct: inventory.requestProductDeletion,
    deleteClient: contacts.deleteClient,
    deleteSupplier: contacts.deleteSupplier,
    updateClientField: contacts.updateClientField,
    updateClientAll: contacts.updateClientAll,
    updateSupplierField: contacts.updateSupplierField,
    updateSupplierAll: contacts.updateSupplierAll,
    dataStale: businessData.dataStale,
    reloadData: businessData.loadBusiness,
  };
}
