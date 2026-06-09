"use client";

import { useEffect } from "react";
import { isCapacitor } from "@/lib/capacitor-helpers";

export function ServiceWorkerRegistrar() {

  useEffect(() => {
    // Skip SW registration inside the Capacitor WebView (Android/iOS).
    // The WebView loads the prod URL so our SW would be registered there too,
    // causing controllerchange → reload loops inside the native shell.
    if (isCapacitor()) return;

    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/api/service-worker", { scope: "/" })
      .then((reg) => {
        // Eagerly check for a new SW version on every page load.
        reg.update().catch(() => {/* network unavailable — offline mode, ignore */});
      })
      .catch((err) => { console.error("SW registration failed:", err); });

    // A PWA resumed from the app-switcher does NOT remount this component, so
    // the load-time reg.update() above never runs on warm resume — the user
    // keeps the stale cached bundle after a deploy until a full cold start.
    // Re-check for a new SW whenever the app becomes visible again; the browser
    // throttles redundant update() calls so this is cheap. On a hit, the SW's
    // activate → controllerchange path auto-reloads via scheduleReload() below.
    // Source: https://web.dev/articles/service-worker-lifecycle (update on focus)
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      navigator.serviceWorker.ready
        .then((reg) => reg.update())
        .catch(() => {/* offline — ignore */});
    };
    document.addEventListener("visibilitychange", onVisible);

    // When a new SW activates and calls clients.claim(), this fires.
    // Previously this was gated on visibilityState === "hidden", which meant
    // Capacitor WebView (always foreground) NEVER reloaded — leaving users
    // on stale JS indefinitely. We now reload unconditionally, but we guard
    // against interrupting an in-progress action with a 300 ms microtask
    // delay so any pending XHR/fetch completes first.
    const onControllerChange = () => { scheduleReload(); };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    // Fallback for browsers where WindowClient.navigate() is unavailable:
    // the SW posts SW_UPDATED via postMessage() instead of calling navigate().
    // Modern Chrome always takes the navigate() path, so this fires rarely.
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type === "SW_UPDATED") {
        scheduleReload();
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      navigator.serviceWorker.removeEventListener("message", onMessage);
    };
  }, []);

  return null;
}

function scheduleReload() {
  // Module-level flag so multiple event paths don't double-fire.
  if (reloadPending) return;
  reloadPending = true;
  // 300 ms delay: lets the current JS tick finish (e.g. a sale confirmation
  // response being processed) before the reload interrupts the UI.
  setTimeout(() => { window.location.reload(); }, 300);
}

// Module-level (not component state) so it survives re-renders.
let reloadPending = false;
