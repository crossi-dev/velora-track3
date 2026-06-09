"use client";

import { useMemo, type FormEvent, type Dispatch, type SetStateAction } from "react";
import type {
  QuickActionMode,
  SettingsFormState,
  TabKey,
} from "../types";
import type { useAssistantState } from "./useAssistantState";
import type { useBusinessData } from "./useBusinessData";
import type { useChatHistory } from "./useChatHistory";
import type { useContacts } from "./useContacts";
import type { useContactsUI } from "./useContactsUI";
import type { useInventory } from "./useInventory";
import type { useQuickActions } from "./useQuickActions";
import type { useSalesInvoices } from "./useSalesInvoices";
import type { useUIState } from "./useUIState";
import type { useDashboardDocuments } from "../useDashboardDocuments";
import {
  handleSaveSettings as handleSaveSettingsHandler,
} from "../hooks.handlers";
export type { DashboardReturnContext } from "./useDashboardReturn";
export { buildDashboardReturn } from "./useDashboardReturn";

type AssistantReturn = ReturnType<typeof useAssistantState>;
type BusinessDataReturn = ReturnType<typeof useBusinessData>;
type ChatHistoryReturn = ReturnType<typeof useChatHistory>;
type UIStateReturn = ReturnType<typeof useUIState>;
type DocumentsReturn = ReturnType<typeof useDashboardDocuments>;
type ContactsReturn = ReturnType<typeof useContacts>;
type ContactsUIReturn = ReturnType<typeof useContactsUI>;
type InventoryReturn = ReturnType<typeof useInventory>;
type QuickActionsReturn = ReturnType<typeof useQuickActions>;
type SalesInvoicesReturn = ReturnType<typeof useSalesInvoices>;

export interface DashboardHandlersContext {
  assistant: AssistantReturn;
  businessData: BusinessDataReturn;
  chatHistoryHook: ChatHistoryReturn;
  setActiveTab: Dispatch<SetStateAction<TabKey>>;
  setQuickAction: Dispatch<SetStateAction<QuickActionMode>>;
  setParseError: Dispatch<SetStateAction<string | null>>;
  setConfirmError: Dispatch<SetStateAction<string | null>>;
  setQuickActionError: Dispatch<SetStateAction<string | null>>;
  setErrorNotice: Dispatch<SetStateAction<string | null>>;
  clearDurableChatHistory: () => Promise<void>;
  downloadInvoicePdf: DocumentsReturn["downloadInvoicePdf"];
  sendInvoiceByWhatsapp: DocumentsReturn["sendInvoiceByWhatsapp"];
  downloadPurchaseRequestPdf: DocumentsReturn["downloadPurchaseRequestPdf"];
}

/**
 * Builds the bundle of inline handler closures that used to live inside
 * `useDashboardState`. Extracted here so the main hub stays under the
 * 400-LOC ceiling; behavior is unchanged (plain closures, no memoization,
 * same as before).
 */
export function buildDashboardHandlers(ctx: DashboardHandlersContext) {
  return {
    handleGo: async (txt?: string) => {
      ctx.setParseError(null);
      ctx.setConfirmError(null);
      ctx.setQuickActionError(null);
      const result = await ctx.assistant.handleGo(txt);
      if (result === "CLEAR_CHAT") await ctx.clearDurableChatHistory();
    },
    handleAssistantFollowUpSubmit: async (e: FormEvent) => {
      e.preventDefault();
      await ctx.assistant.handleGo(ctx.assistant.assistantFollowUpInput, true);
    },
    downloadInvoicePdf: (id: string, num: string) =>
      ctx.downloadInvoicePdf(id, num, { emitChatMessage: true }),
    sendInvoiceByWhatsapp: (
      invoiceId: string,
      invoiceNumber: string,
      opts?: { emitChatMessage?: boolean; emitErrorChatMessage?: boolean }
    ) =>
      ctx.sendInvoiceByWhatsapp(invoiceId, invoiceNumber, {
        emitChatMessage: opts?.emitChatMessage ?? true,
        emitErrorChatMessage: opts?.emitErrorChatMessage ?? true,
      }),
    downloadPurchaseRequestPdf: (id: string, num: string) =>
      ctx.downloadPurchaseRequestPdf(id, num, { emitChatMessage: true }),
    handleCuitSaved: () => ctx.businessData.loadBusiness({ silent: true, force: true }).catch(() => {}),
    openSellProductHelper: (productName: string) => {
      ctx.setActiveTab("main");
      ctx.assistant.setInput(`Vendí 1 ${productName}`);
    },
    updateAssistantStockField: (field: "supplierName", val: string) => {
      ctx.assistant.setAssistantStockDraft(
        ctx.assistant.assistantStockDraft
          ? { ...ctx.assistant.assistantStockDraft, [field]: val }
          : null
      );
    },
    sendPurchaseRequestToSupplier: () =>
      ctx.assistant.sendPurchaseRequestToSupplier(undefined, { emitChatMessage: true }),
    updateSettingsField: (field: keyof SettingsFormState, val: string) => {
      ctx.businessData.setSettingsForm((curr) =>
        curr ? { ...curr, [field]: val } : curr
      );
    },
    handleSaveSettings: (e: FormEvent) =>
      handleSaveSettingsHandler(e, {
        settingsForm: ctx.businessData.settingsForm,
        setLoadingSettings: ctx.businessData.setLoadingSettings,
        setSettingsError: ctx.businessData.setSettingsError,
        setSettingsNotice: ctx.businessData.setSettingsNotice,
        loadBusiness: ctx.businessData.loadBusiness,
        appendChatHistoryEntry: ctx.chatHistoryHook.appendChatHistoryEntry,
      }),
    openQuickAction: (action: QuickActionMode) => {
      ctx.setActiveTab("main");
      ctx.setQuickAction(action);
    },
  };
}

/**
 * Memoized UI resource projections (tab labels, section metadata, quick
 * action list). Extracted from `useDashboardState` to keep the main hub
 * focused on state + sub-hook composition.
 */
export function useDashboardUIResources(
  uiState: UIStateReturn,
  locale: string,
  activeTab: TabKey
) {
  const localeKey = locale.startsWith("es") ? "es" : "en";

  const tabLabel = useMemo(
    () => (tab: TabKey) => uiState.tabLabels[tab][localeKey],
    [uiState.tabLabels, localeKey]
  );

  const activeSectionMeta = useMemo(
    () =>
      activeTab === "main"
        ? null
        : {
            eyebrow: uiState.sectionMeta[activeTab].eyebrow[localeKey],
            title: uiState.sectionMeta[activeTab].title[localeKey],
            description: uiState.sectionMeta[activeTab].description[localeKey],
          },
    [activeTab, uiState.sectionMeta, localeKey]
  );

  const dashboardQuickActions = useMemo(
    () =>
      uiState.dashboardQuickActions.map((a) => ({
        key: a.key,
        title: localeKey === "en" ? a.titleEN : a.titleES,
        example: localeKey === "en" ? a.exampleEN : a.exampleES,
      })),
    [uiState.dashboardQuickActions, localeKey]
  );

  return { tabLabel, activeSectionMeta, dashboardQuickActions };
}

