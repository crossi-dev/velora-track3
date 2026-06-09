"use client";

import { useEffect, useRef } from "react";
import { isCapacitor } from "@/lib/capacitor-helpers";
import { overlayOpenRef } from "./hooks/overlayState";
import type { TabKey } from "./types";

interface UseAndroidBackButtonOptions {
  activeTab: TabKey;
  setActiveTab: (tab: TabKey) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  quickAction: string | null;
  setQuickAction: (action: null) => void;
  reloadData: () => void;
  refreshChatHistory?: () => void;
}

const RESUME_REFRESH_TTL_MS = 60_000;

/**
 * Handle Android hardware back button and app resume in Capacitor.
 *
 * Registers listeners ONCE and reads current state from refs —
 * no re-registration on state changes, no bridge re-crossing.
 *
 * On resume: refreshes business data if the last load was >60 s ago
 * to avoid hammering the server on brief foreground switches.
 */
export function useAndroidBackButton(opts: UseAndroidBackButtonOptions) {
  const activeTabRef = useRef(opts.activeTab);
  activeTabRef.current = opts.activeTab;
  const sidebarOpenRef = useRef(opts.sidebarOpen);
  sidebarOpenRef.current = opts.sidebarOpen;
  const quickActionRef = useRef(opts.quickAction);
  quickActionRef.current = opts.quickAction;

  const setActiveTabRef = useRef(opts.setActiveTab);
  setActiveTabRef.current = opts.setActiveTab;
  const setSidebarOpenRef = useRef(opts.setSidebarOpen);
  setSidebarOpenRef.current = opts.setSidebarOpen;
  const setQuickActionRef = useRef(opts.setQuickAction);
  setQuickActionRef.current = opts.setQuickAction;

  const reloadDataRef = useRef(opts.reloadData);
  reloadDataRef.current = opts.reloadData;
  const refreshChatHistoryRef = useRef(opts.refreshChatHistory);
  refreshChatHistoryRef.current = opts.refreshChatHistory;

  // Tracks when data was last loaded so we apply the 60 s TTL guard
  const lastLoadTimeRef = useRef<number>(Date.now());

  useEffect(() => {
    if (!isCapacitor()) return;

    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const { App } = await import("@capacitor/app");

        const backListener = await App.addListener("backButton", () => {
          // If any overlay (BottomSheet, modal) is open it already registered
          // its own listener and handled the event — bail out to avoid a race
          // where the sheet closes AND the app minimises on the same press.
          if (overlayOpenRef.current) return;

          if (quickActionRef.current) {
            setQuickActionRef.current(null);
            return;
          }
          if (sidebarOpenRef.current) {
            setSidebarOpenRef.current(false);
            return;
          }
          if (activeTabRef.current !== "main") {
            setActiveTabRef.current("main");
            return;
          }
          void App.minimizeApp();
        });

        const resumeListener = await App.addListener("appStateChange", ({ isActive }) => {
          if (!isActive) return;
          const now = Date.now();
          if (now - lastLoadTimeRef.current >= RESUME_REFRESH_TTL_MS) {
            lastLoadTimeRef.current = now;
            reloadDataRef.current();
            refreshChatHistoryRef.current?.();
          }
        });

        cleanup = () => {
          backListener.remove();
          resumeListener.remove();
        };
      } catch {
        // @capacitor/app not available
      }
    })();

    return () => cleanup?.();
  }, []); // Register once — refs keep state fresh

  // Expose a setter so DashboardPage can update the last-load timestamp
  // when a fresh load completes (e.g. initial mount).
  return {
    markLoaded: () => {
      lastLoadTimeRef.current = Date.now();
    },
  };
}
