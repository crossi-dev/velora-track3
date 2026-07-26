"use client";

import { useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { applyAppSettingsToDOM } from "./lib/appSettings";
import { DashboardLayout } from "./components/DashboardLayout";
import { useDashboardState } from "./lib/hooks";
import { DashboardProviders, type ActorRole } from "./lib/contexts";
import { DashboardLangProvider } from "./lib/DashboardLangContext";
import { DashboardQueryClientProvider } from "./lib/query-client";
import { VeloraSidebar } from "./components/Sidebar";
import { BottomNav } from "./components/BottomNav";
import { toast } from "sonner";
import { DashboardLoadingState } from "./components/DashboardLoadingState";
import { DashboardTabContent } from "./components/DashboardTabContent";
import { OnboardingChat } from "./components/OnboardingChat";
import { StaleDataBanner } from "./components/StaleDataBanner";
import { InstallAppBanner } from "./components/InstallAppBanner";
import { CapabilityBuoyBanner } from "./components/CapabilityBuoyBanner";
import type { BusinessCapabilities } from "@/lib/business-capabilities";
import { useAndroidBackButton } from "./lib/useAndroidBackButton";
import { usePlannerCheck } from "./lib/hooks/usePlannerCheck";
import { usePushSubscriptionPrompt } from "./lib/hooks/usePushSubscriptionPrompt";

const SUCCESS_TOAST_DURATION_MS = 3500;
// Stable ID constants so re-renders replace the same Sonner toast instead of stacking.
const TOAST_ID_SUCCESS = "dashboard-success";
const TOAST_ID_ERROR = "dashboard-error";
const TOAST_ID_QUICK_ACTION_ERROR = "dashboard-quick-action-error";

export default function DashboardPage({
  role = "owner",
  capabilities = null,
}: {
  role?: ActorRole;
  /** SSR capability map (Stripe currently_due pattern). Null for employee sessions. */
  capabilities?: BusinessCapabilities | null;
}) {
  return (
    <DashboardQueryClientProvider>
      <DashboardLangProvider>
        <DashboardInner role={role} capabilities={capabilities} />
      </DashboardLangProvider>
    </DashboardQueryClientProvider>
  );
}

// eslint-disable-next-line max-lines-per-function -- page root, not a logic violation
function DashboardInner({
  role = "owner",
  capabilities = null,
}: {
  role?: ActorRole;
  capabilities?: BusinessCapabilities | null;
}) {
  usePlannerCheck();

  const searchParams = useSearchParams();
  const state = useDashboardState();

  const {
    activeTab,
    setActiveTab,
    business,
    successNotice,
    setUndoAction,
    freshInvoiceId,
    setFreshInvoiceId,
    errorNotice,
    setErrorNotice,
    quickAction,
    setQuickAction,
    quickActionError,
    setQuickActionError,
    setActiveInvoiceId,
    setInvoiceSheetOpen,
    notifications,
    tabLabel,
    chatHistory,
    loadingPage,
    pageError,
    dataStale,
    reloadData,
    refreshChatHistory,
    sales,
    employeeName,
    t,
  } = state;

  // Cold-start push tap: if the app was killed and the user tapped an FCM or
  // Web Push notification, both paths append ?openTab=main&from=push to the URL.
  // Read it once at mount to select the correct tab without relying on a
  // postMessage that races page hydration.
  useEffect(() => {
    if (searchParams.get("openTab") === "main") {
      setActiveTab("main");
    }
    // Run-once on mount: capture the initial ?openTab query and seed the tab state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Permission prompt for the daily-summary push fires once per device.
  // Owner: gated on Business.firstSaleConfirmed — set server-side the moment
  // the first owner-driven sale closes, paired with an in-chat priming
  // message (primer first, OS dialog second; never a cold ask on mount).
  // Employee: gated on >=1 confirmed sale via post-first-sale onboarding
  // transition copy. Same primer-first-OS-dialog-second pattern.
  const ownerFirstSaleConfirmed = role === "owner" && business?.firstSaleConfirmed === true;
  usePushSubscriptionPrompt({ hasConfirmedSale: ownerFirstSaleConfirmed });

  useEffect(() => { applyAppSettingsToDOM(); }, []);

  // reloadData is recreated on every render (it's a plain async function in
  // useBusinessData, not memoized). Listing it in deps re-attaches the
  // visibilitychange listener every render, which is wasteful and races
  // teardown vs the fired event during state churn. Stabilize with a ref so
  // the listener registers exactly once and always reads the latest
  // reloadData/refreshChatHistory.
  const reloadDataRef = useRef(reloadData);
  reloadDataRef.current = reloadData;
  const refreshChatHistoryRef = useRef(refreshChatHistory);
  refreshChatHistoryRef.current = refreshChatHistory;

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        void reloadDataRef.current({ silent: true });
        refreshChatHistoryRef.current();
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => { document.removeEventListener("visibilitychange", handleVisibilityChange); };
  }, []);

  // Stabilize setActiveTab in a ref so the SW message listener registers only
  // once on mount and always calls the latest setter without stale closure risk.
  const setActiveTabRef = useRef(setActiveTab);
  useEffect(() => { setActiveTabRef.current = setActiveTab; });

  useEffect(() => {
    function handleSwMessage(e: MessageEvent) {
      if (e.data?.type === "SW_OPEN_CHAT") setActiveTabRef.current("main");
    }
    navigator.serviceWorker?.addEventListener("message", handleSwMessage);
    return () => { navigator.serviceWorker?.removeEventListener("message", handleSwMessage); };
  }, []);

  // Android back button: sidebar state is now managed by SidebarProvider (shadcn).
  // On Capacitor/mobile the sidebar is hidden (BottomNav replaces it), so
  // sidebarOpen is always false for the back-button handler — no regression.
  const { markLoaded } = useAndroidBackButton({
    activeTab, setActiveTab,
    sidebarOpen: false,
    setSidebarOpen: () => { /* shadcn SidebarProvider manages this */ },
    quickAction, setQuickAction: () => setQuickAction(null),
    reloadData, refreshChatHistory,
  });

  useEffect(() => { if (!loadingPage) markLoaded(); }, [loadingPage]);

  // Success toast — fires when successNotice changes to a non-null string.
  // onDismiss/onAutoClose clear the paired state so the same message
  // can re-trigger on the next sale without being silently ignored.
  useEffect(() => {
    if (!successNotice) { toast.dismiss(TOAST_ID_SUCCESS); return; }
    const action = freshInvoiceId
      ? {
          label: t("View invoice", "Ver factura"),
          onClick: () => { setActiveInvoiceId(freshInvoiceId); setInvoiceSheetOpen(true); },
        }
      : undefined;
    toast.success(successNotice, {
      id: TOAST_ID_SUCCESS,
      duration: SUCCESS_TOAST_DURATION_MS,
      action,
      onDismiss: () => { setUndoAction(null); setFreshInvoiceId(null); },
      onAutoClose: () => { setUndoAction(null); setFreshInvoiceId(null); },
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [successNotice]);

  // Error toast — persists until manually dismissed (duration=Infinity).
  useEffect(() => {
    if (!errorNotice) { toast.dismiss(TOAST_ID_ERROR); return; }
    toast.error(errorNotice, {
      id: TOAST_ID_ERROR,
      duration: Infinity,
      onDismiss: () => setErrorNotice(null),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorNotice]);

  // Quick-action error toast — persists until manually dismissed.
  useEffect(() => {
    if (!quickActionError) { toast.dismiss(TOAST_ID_QUICK_ACTION_ERROR); return; }
    toast.error(quickActionError, {
      id: TOAST_ID_QUICK_ACTION_ERROR,
      duration: Infinity,
      onDismiss: () => setQuickActionError(null),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quickActionError]);

  return (
    <DashboardProviders state={state} role={role}>
      <DashboardLayout
        t={t}
        sidebar={
          <VeloraSidebar
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            tabLabel={tabLabel}
            t={t}
          />
        }
        onQuickActionsClick={() => setQuickAction((current) => (current === "menu" ? null : "menu"))}
        quickActionOpen={quickAction === "menu"}
        contentScrollable={activeTab !== "main"}
        title={role === "employee" ? (employeeName || "Velora") : (business?.name || "Velora")}
        notifications={notifications}
        bottomNav={
          <div className="md:hidden">
            <BottomNav
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              tabLabel={tabLabel}
              t={t}
            />
          </div>
        }
      >
        {/* Toasts are now fired imperatively via sonner (see useEffect hooks above).
            The <Toaster /> is mounted once in src/app/layout.tsx. */}
        <StaleDataBanner
          visible={!!dataStale}
          onRetry={() => void reloadData()}
          t={t}
        />
        <InstallAppBanner
          triggered={chatHistory.some((e) => e.source === "assistant")}
        />

        {/* Step 1.5c: Capability buoy banner — owner only, non-main tabs only.
          Pull revelation pattern (NNGroup): shown when capabilities are missing.
          Hidden on the main chat tab so it doesn't interrupt conversation flow.
          Source: https://www.nngroup.com/articles/onboarding-tutorials/ */}
        {role === "owner" && capabilities && activeTab !== "main" && (
          <CapabilityBuoyBanner
            capabilities={capabilities}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TabKey is a string union; the banner accepts string for decoupling.
            onNavigate={setActiveTab as (tab: string) => void}
          />
        )}

        <div className={`flex flex-1 min-h-0 flex-col ${activeTab === "main" ? "overflow-hidden" : "overflow-visible"}`}>
          <div
            className={`min-w-0 w-full ${activeTab === "main" ? "flex-1 min-h-0 overflow-hidden px-0 py-0" : "px-4 pt-4 content-safe-scroll md:px-5 md:pt-5"}`}
            style={{ boxSizing: "border-box", ...(activeTab === "main" ? { display: "flex", flexDirection: "column" } : {}) }}
          >
            <DashboardLoadingState loadingPage={loadingPage} pageError={pageError} onRetry={() => void reloadData()} t={t} />

            {!loadingPage && !pageError && business && (
              // Camino normal: el dueño llega acá con un Business ya creado por
              // events.createUser (auth.ts). El default activeTab="main" abre
              // directo el chat con el supervisor — ahí corre el onboarding
              // conversacional (nombre → bienvenida al checklist).
              <DashboardTabContent capabilities={role === "owner" ? capabilities : null} />
            )}
            {!loadingPage && !pageError && !business && (
              // Fallback defensivo: si por alguna razón el placeholder Business
              // no se creó (race en el hook createUser, fallo de DB), caemos al
              // formulario legacy. No deberíamos llegar acá en flujo normal.
              <OnboardingChat onComplete={() => void reloadData()} />
            )}
          </div>
        </div>
      </DashboardLayout>
    </DashboardProviders>
  );
}
