"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { STORAGE_KEY } from "./storage-keys";
import { useAssistantState } from "./hooks/useAssistantState";
import { useBusinessData } from "./hooks/useBusinessData";
import { useSalesInvoices } from "./hooks/useSalesInvoices";
import { useInventory } from "./hooks/useInventory";
import { useContacts } from "./hooks/useContacts";
import { useUIState } from "./hooks/useUIState";
import { useQuickActions } from "./hooks/useQuickActions";
import { useContactsUI } from "./hooks/useContactsUI";
import { useChatHistory } from "./hooks/useChatHistory";
import { useDraftPersistence, PERSISTENCE_KEY_PREFIX } from "./useDraftPersistence";
import { useDashboardDocuments } from "./useDashboardDocuments";
import { navigateFromUserAction } from "./navigate";
import { resolveBrowserLocale } from "./hooks/utils";
import {
  useCurrentCash,
  useTotalIncome,
  useTotalExpense,
  useInventoryChanges,
  resolveSelectedInvoice,
  selectedInvoiceViewFields,
  selectLatestPurchaseRequestPayload,
} from "./hooks.analytics";
import {
  assistantMoneyFmt,
  buildDashboardFormatters,
} from "./hooks.formatters";
import {
  performImport as performImportHandler,
} from "./hooks.handlers";
import {
  buildDashboardHandlers,
  buildDashboardReturn,
  useDashboardUIResources,
} from "./hooks/useDashboardHandlers";
import { useDashboardLang } from "./DashboardLangContext";
import { getMpOAuthErrorMessage } from "./mp-oauth-errors";
import type {
  TabKey,
  QuickActionMode,
  ChatHistoryEntry,
  PurchaseRequestRecord,
} from "./types";

// eslint-disable-next-line max-lines-per-function -- composition root, not a logic violation
export function useDashboardState() {
  const { t } = useDashboardLang();
  const [activeTab, setActiveTab] = useState<TabKey>(() => {
    if (typeof window === "undefined") return "main";
    // OAuth callbacks (e.g. MP) redirect to /dashboard?tab=settings&mp=...
    // Query string takes precedence over localStorage so the owner lands on
    // the right tab after authorising an integration.
    const VALID_TABS: TabKey[] = ["main", "sales", "inventory", "budget", "invoices", "clients", "suppliers", "team", "servicios", "settings"];
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get("tab");
    if (fromQuery && (VALID_TABS as string[]).includes(fromQuery)) {
      return fromQuery as TabKey;
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY.APP_SETTINGS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed.alwaysOpenMain === false) return "sales" as TabKey;
      }
    } catch { /* ignore */ }
    return "main";
  });
  const [quickAction, setQuickAction] = useState<QuickActionMode>(null);
  const [locale, setLocale] = useState("es-AR");
  const [loadingPage, setLoadingPage] = useState(true);
  const [pageError, setPageError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [undoAction, setUndoActionRaw] = useState<(() => Promise<void>) | null>(null);
  // React's useState treats a plain function argument as an UPDATER —
  // it calls the function with prevState and expects the new state in
  // return. For function-typed state that footgun means passing
  // `setUndoAction(async () => { ... })` would invoke the callback
  // immediately (firing the undo on commit). Wrap every assignment in
  // an updater that returns the value unchanged so consumers can treat
  // this like any ordinary setter.
  const setUndoAction = useCallback((fn: (() => Promise<void>) | null) => {
    setUndoActionRaw(() => fn);
  }, []);
  const [freshInvoiceId, setFreshInvoiceId] = useState<string | null>(null);
  const [latestPurchaseRequest, setLatestPurchaseRequest] = useState<PurchaseRequestRecord | null>(null);
  const [purchaseActionNotice, setPurchaseActionNotice] = useState<string | null>(null);

  const saleDraftRef = useRef<HTMLDivElement>(null);
  const appendChatHistoryEntryRef = useRef<(kind: ChatHistoryEntry["kind"], text: string) => void>(() => {});

  const [parseError, setParseError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [quickActionError, setQuickActionError] = useState<string | null>(null);
  const [quickActionFormSaving, setQuickActionFormSaving] = useState(false);
  // Bible §4: facturas absorbidas en Ventas. Sheet inline reemplaza la tab
  // dedicada. Eleva al state level para que callers desde fuera de
  // DashboardTabContent (Toast post-confirm en DashboardPage, action handler
  // invoices.ts) puedan abrir el sheet sin switchear de tab.
  const [invoiceSheetOpen, setInvoiceSheetOpen] = useState(false);

  // --- Initialize Hooks ---
  const businessData = useBusinessData({
    locale,
    setPageError,
    setLoadingPage,
    setSuccessNotice,
    appendChatHistoryEntry: (kind, text) => appendChatHistoryEntryRef.current(kind, text),
    t
  });

  const uiState = useUIState();

  const persistenceKey = businessData.businessId ? `${PERSISTENCE_KEY_PREFIX}${businessData.businessId}` : null;

  const chatHistoryHook = useChatHistory({
    businessId: businessData.businessId,
    persistenceKey,
  });

  appendChatHistoryEntryRef.current = chatHistoryHook.appendChatHistoryEntry;

  const conversationalHistory = chatHistoryHook.chatHistory.filter((entry) => !entry.id.startsWith("trace:"));

  const salesInvoices = useSalesInvoices({
    businessId: businessData.businessId,
    setPageError,
    setErrorNotice,
    setSuccessNotice,
    setDownloadingInvoiceId: uiState.setDownloadingInvoiceId,
    loadBusiness: businessData.loadBusiness,
    markUpdated: businessData.markUpdated
  });

  const { sendInvoiceByWhatsapp, downloadInvoicePdf, downloadPurchaseRequestPdf } = useDashboardDocuments({
    sendInvoiceByWhatsappBase: salesInvoices.sendInvoiceByWhatsapp,
    downloadInvoicePdfBase: salesInvoices.downloadInvoicePdf,
    appendChatHistoryEntry: chatHistoryHook.appendChatHistoryEntry,
    appendDurableChatHistoryEntry: chatHistoryHook.appendDurableChatHistoryEntry,
    setDownloadingPurchaseRequestId: uiState.setDownloadingPurchaseRequestId,
    setErrorNotice,
  });

  const inventory = useInventory({
    businessId: businessData.businessId,
    loadBusiness: businessData.loadBusiness,
    markUpdated: businessData.markUpdated,
    setPageError,
    setUndoAction,
    appendChatHistoryEntry: chatHistoryHook.appendChatHistoryEntry,
    products: businessData.products,
  });

  const contacts = useContacts({
    businessId: businessData.businessId,
    loadBusiness: businessData.loadBusiness,
    markUpdated: businessData.markUpdated,
    setPageError
  });

  // Derived analytics (extracted to hooks.analytics.ts)
  const currentCash = useCurrentCash(businessData.business?.openingCash, businessData.cashTotal);
  const totalIncome = useTotalIncome(businessData.cashMovements);
  const totalExpense = useTotalExpense(businessData.cashMovements);
  const inventoryChanges = useInventoryChanges(businessData.stockMovements);
  const selectedInvoice = resolveSelectedInvoice(businessData.invoices, salesInvoices.activeInvoiceId);
  const latestPurchaseRequestPayload = selectLatestPurchaseRequestPayload(latestPurchaseRequest);
  const {
    selectedInvoiceBusiness,
    selectedInvoiceCustomer,
    selectedInvoiceSale,
  } = selectedInvoiceViewFields(selectedInvoice);

  const contactsUI = useContactsUI({
    businessId: businessData.businessId,
    loadBusiness: businessData.loadBusiness,
    markUpdated: businessData.markUpdated,
    setActiveTab,
    setPageError,
    setSuccessNotice,
    setErrorNotice,
    setUndoAction,
    appendChatHistoryEntry: chatHistoryHook.appendChatHistoryEntry
  });

  const assistant = useAssistantState({
    businessId: businessData.businessId,
    locale,
    businessName: businessData.business?.name,
    businessCurrency: businessData.business?.currency,
    activeInvoiceId: salesInvoices.activeInvoiceId,
    latestPurchaseRequest,
    chatHistory: conversationalHistory,
    products: businessData.products,
    clients: businessData.clients,
    manufacturers: businessData.manufacturers,
    invoices: businessData.invoices,
    sales: businessData.sales,
    currentCash,
    loadBusiness: businessData.loadBusiness,
    setActiveTab: (tab: string) => setActiveTab(tab as TabKey),
    setActiveInvoiceId: salesInvoices.setActiveInvoiceId,
    setInvoiceSheetOpen,
    setErrorNotice,
    setSuccessNotice,
    setUndoAction,
    setFreshInvoiceId,
    notifyChatSuccess: (msg: string) => chatHistoryHook.appendDurableChatHistoryEntry("success", msg),
    setParseError,
    setConfirmError,
    setQuickActionError,
    setInvoiceStatusNotice: salesInvoices.setInvoiceStatusNotice,
    setPurchaseActionNotice,
    appendChatHistoryEntry: chatHistoryHook.appendChatHistoryEntry,
    appendDurableChatHistoryEntry: chatHistoryHook.appendDurableChatHistoryEntry,
    refreshChatHistory: chatHistoryHook.refreshChatHistory,
    clearStaleSaleDraftPrompt: () => {
      chatHistoryHook.setChatHistory((current) => current.filter((entry) => !chatHistoryHook.isStaleSaleDraftPrompt(entry)));
    },
    updateSupplierField: contacts.updateSupplierField,
    updateClientField: contacts.updateClientField,
    updateProduct: inventory.updateProduct,
    deleteProduct: inventory.requestProductDeletion,
    updateInvoiceStatus: salesInvoices.updateInvoiceStatus,
    downloadInvoicePdf,
    downloadPurchaseRequestPdf,
    setLatestPurchaseRequest,
    navigateFromUserAction: (url: string) => {
      const result = navigateFromUserAction(url);
      if (result) {
        const isWhatsApp = url.includes("wa.me");
        setSuccessNotice(isWhatsApp ? t("Opening WhatsApp...", "Abriendo WhatsApp...") : t("Opening PDF...", "Abriendo PDF..."));
        setErrorNotice(null);
      }
      return result;
    },
    moneyFmt: assistantMoneyFmt,
    t
  });

  const quickActions = useQuickActions({
    businessId: businessData.businessId,
    products: businessData.products,
    clients: businessData.clients,
    loadBusiness: businessData.loadBusiness,
    setQuickAction,
    setQuickActionError,
    setQuickActionSaving: setQuickActionFormSaving,
    setSuccessNotice,
    setErrorNotice,
    setUndoAction,
    setActiveTab,
    setActiveInvoiceId: salesInvoices.setActiveInvoiceId,
    markUpdated: businessData.markUpdated,
    appendChatHistoryEntry: chatHistoryHook.appendChatHistoryEntry,
    dispatchSaleAction: assistant.dispatchSaleAction,
    t
  });

  useDraftPersistence({
    persistenceKey,
    setLatestPurchaseRequest,
    setAssistantStockDraft: assistant.setAssistantStockDraft,
    setAssistantConfirmationRequest: assistant.setAssistantConfirmationRequest,
    setAssistantQuestionContext: assistant.setAssistantQuestionContext,
    setAssistantInputHint: assistant.setAssistantInputHint,
    latestPurchaseRequest,
    assistantStockDraft: assistant.assistantStockDraft,
    assistantConfirmationRequest: assistant.assistantConfirmationRequest,
    assistantQuestionContext: assistant.assistantQuestionContext,
    assistantInputHint: assistant.assistantInputHint,
    manufacturers: businessData.manufacturers,
    products: businessData.products,
    parsed: assistant.parsed,
    setParsed: assistant.setParsed,
    setDraftPriceValidated: assistant.setDraftPriceValidated,
  });

  const clearDurableChatHistory = useCallback(async () => {
    setLatestPurchaseRequest(null);
    setPurchaseActionNotice(null);
    await chatHistoryHook.clearDurableChatHistory(setErrorNotice);
  }, [chatHistoryHook.clearDurableChatHistory]);

  // Handle OAuth return params (e.g. MP callback → /dashboard?tab=settings&mp=connected).
  // Runs once on mount: reads `mp` from the URL, fires the right notice, then
  // replaces the history entry to strip query params so a refresh doesn't
  // replay the toast.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const mp = params.get("mp");
    if (mp) {
      if (mp === "connected") {
        setSuccessNotice(t(
          "Mercado Pago connected. You can now collect QR payments.",
          "Mercado Pago conectado. Ya podés cobrar QR."
        ));
      } else {
        const reason = params.get("reason");
        setErrorNotice(getMpOAuthErrorMessage(reason));
      }
      window.history.replaceState({}, "", "/dashboard");
    }
  }, []);

  // Initial Locale setup
  useEffect(() => {
    const nextLocale = resolveBrowserLocale();
    setLocale(nextLocale);
    businessData.loadBusiness();
  }, []);

  // Thin closures that bind the extracted handlers to local deps.
  const performImport = (type: "products" | "customers" | "suppliers", file: File) =>
    performImportHandler(type, file, {
      loadBusiness: businessData.loadBusiness,
      markUpdated: businessData.markUpdated,
    });

  const { tabLabel: tabLabelFn, activeSectionMeta: activeSectionMetaValue, dashboardQuickActions: dashboardQuickActionsValue } =
    useDashboardUIResources(uiState, locale, activeTab);

  const formatters = buildDashboardFormatters(locale, t);

  const handlers = buildDashboardHandlers({
    assistant,
    businessData,
    chatHistoryHook,
    setActiveTab,
    setQuickAction,
    setParseError,
    setConfirmError,
    setQuickActionError,
    setErrorNotice,
    clearDurableChatHistory,
    downloadInvoicePdf,
    sendInvoiceByWhatsapp,
    downloadPurchaseRequestPdf,
  });

  return {
    ...buildDashboardReturn({
      locale, activeTab, setActiveTab,
      uiState, businessData, assistant, chatHistoryHook, salesInvoices,
      contacts, contactsUI, inventory, quickActions,
      loadingPage, pageError,
      parseError, setParseError,
      confirmError, setConfirmError,
      successNotice, errorNotice, setErrorNotice,
      undoAction, setUndoAction,
      freshInvoiceId, setFreshInvoiceId,
      latestPurchaseRequest, purchaseActionNotice, setPurchaseActionNotice,
      quickAction, setQuickAction,
      quickActionError, setQuickActionError,
      quickActionFormSaving,
      invoiceSheetOpen, setInvoiceSheetOpen,
      saleDraftRef,
      currentCash, totalIncome, totalExpense, inventoryChanges,
      selectedInvoice, latestPurchaseRequestPayload,
      selectedInvoiceBusiness, selectedInvoiceCustomer, selectedInvoiceSale,
      tabLabel: tabLabelFn,
      activeSectionMeta: activeSectionMetaValue,
      dashboardQuickActions: dashboardQuickActionsValue,
      performImport,
      t,
    }),
    ...handlers,
    ...formatters,
  };
}
