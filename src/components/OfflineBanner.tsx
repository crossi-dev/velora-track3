"use client";

import { useState, useEffect, useRef } from "react";
import { X } from "@phosphor-icons/react";
import { getAll, subscribe } from "@/app/dashboard/lib/offline-queue";
import { CHAT_EVENT } from "@/app/dashboard/lib/chat-events";

type QuotaDetail = { evicted: number; remaining: number; fatal?: boolean };

/**
 * Global banner: shows "Sin conexión" when the browser is offline, and
 * transitions to "Sincronizando…" while the offline queue drains on
 * reconnect. Auto-dismisses ~1.2s after the queue empties.
 *
 * Debouncing: when the queue size flips rapidly during drain, we defer
 * visible-state updates by 200ms so the banner doesn't flash. Reads the
 * current `draining` state from a ref inside the subscriber callback to
 * avoid a stale closure when the effect runs with empty deps.
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [draining, setDraining] = useState(false);
  const [queueCount, setQueueCount] = useState(0);
  const [quotaEvent, setQuotaEvent] = useState<QuotaDetail | null>(null);

  // Mirror `draining` into a ref so subscriber callbacks registered once at
  // mount still read the latest value.
  const drainingRef = useRef(draining);
  drainingRef.current = draining;

  // Listen for quota eviction events dispatched by offline-queue.storage.ts.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<QuotaDetail>).detail;
      setQuotaEvent(detail ?? { evicted: 0, remaining: 0, fatal: true });
    };
    window.addEventListener(CHAT_EVENT.OFFLINE_QUEUE_QUOTA, handler);
    return () => window.removeEventListener(CHAT_EVENT.OFFLINE_QUEUE_QUOTA, handler);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Debounce timers for flicker-prone transitions.
    let countTimer: ReturnType<typeof setTimeout> | null = null;
    let emptyDismissTimer: ReturnType<typeof setTimeout> | null = null;
    let emptyHideTimer: ReturnType<typeof setTimeout> | null = null;

    const clearEmptyTimers = () => {
      if (emptyDismissTimer) {
        clearTimeout(emptyDismissTimer);
        emptyDismissTimer = null;
      }
      if (emptyHideTimer) {
        clearTimeout(emptyHideTimer);
        emptyHideTimer = null;
      }
    };

    const refreshQueue = () => {
      if (countTimer) clearTimeout(countTimer);
      // 200ms debounce: absorbs rapid change bursts during drain.
      countTimer = setTimeout(() => {
        try {
          setQueueCount(getAll().length);
        } catch {
          setQueueCount(0);
        }
      }, 200);
    };

    const goOffline = () => {
      clearEmptyTimers();
      setOffline(true);
      setDismissed(false);
      setDraining(false);
      refreshQueue();
    };

    const goOnline = () => {
      refreshQueue();
      // If there are queued items, flip to "draining" mode and keep the banner
      // visible until the queue empties.
      let items: unknown[] = [];
      try {
        items = getAll();
      } catch {
        items = [];
      }
      if (items.length > 0) {
        clearEmptyTimers();
        setDraining(true);
        setOffline(true);
        setDismissed(false);
      } else {
        clearEmptyTimers();
        emptyDismissTimer = setTimeout(() => setDismissed(true), 1000);
        emptyHideTimer = setTimeout(() => setOffline(false), 1600);
      }
    };

    if (!navigator.onLine) goOffline();
    refreshQueue();

    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);

    const unsub = subscribe(() => {
      refreshQueue();
      // Once the queue empties while we're in drain mode, auto-dismiss the
      // banner. Read latest `draining` from the ref to avoid stale closure.
      let isEmpty = true;
      try {
        isEmpty = getAll().length === 0;
      } catch {
        isEmpty = true;
      }
      if (drainingRef.current && isEmpty) {
        clearEmptyTimers();
        emptyDismissTimer = setTimeout(() => setDismissed(true), 600);
        emptyHideTimer = setTimeout(() => {
          setOffline(false);
          setDraining(false);
        }, 1200);
      }
    });

    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
      unsub();
      if (countTimer) clearTimeout(countTimer);
      clearEmptyTimers();
    };
    // Empty deps: handlers read latest `draining` via ref, not closure.
  }, []);

  const quotaMessage = quotaEvent
    ? quotaEvent.fatal
      ? "Almacenamiento lleno — la cola no se pudo guardar. Conectate cuanto antes."
      : `Almacenamiento casi lleno — descartamos las ${quotaEvent.evicted} acciones más viejas para liberar espacio. Quedan ${quotaEvent.remaining} pendientes.`
    : null;

  if (!offline && !quotaEvent) return null;

  const message = draining
    ? queueCount > 0
      ? `Sincronizando… (${queueCount})`
      : "Sincronizando…"
    : queueCount > 0
      ? `Sin conexión — ${queueCount} ${queueCount === 1 ? "acción" : "acciones"} en cola`
      : "Sin conexión a internet";

  return (
    <>
      {offline && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            zIndex: 99, /* --z-overlay */
            padding: "10px 16px",
            paddingTop: "max(10px, env(safe-area-inset-top, 0px))",
            backgroundColor: draining ? "var(--accent, #2A6F97)" : "var(--danger)",
            color: "#FFFFFF",
            fontFamily: "var(--font-dm-sans), sans-serif",
            fontSize: "0.875rem",
            fontWeight: 600,
            textAlign: "center",
            opacity: dismissed ? 0 : 1,
            transition: "opacity 500ms ease, background-color 300ms ease",
          }}
        >
          {message}
        </div>
      )}
      {quotaEvent && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            position: "fixed",
            top: offline ? "calc(env(safe-area-inset-top, 0px) + 44px)" : 0,
            left: 0,
            right: 0,
            zIndex: "var(--z-overlay-secondary)" as unknown as number,
            padding: "10px 16px",
            paddingTop: offline ? "10px" : "max(10px, env(safe-area-inset-top, 0px))",
            backgroundColor: "var(--warning, #D97706)",
            color: "#FFFFFF",
            fontFamily: "var(--font-dm-sans), sans-serif",
            fontSize: "0.875rem",
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "12px",
          }}
        >
          <span style={{ flex: 1, textAlign: "center" }}>{quotaMessage}</span>
          <button
            type="button"
            onClick={() => setQuotaEvent(null)}
            aria-label="Cerrar aviso de almacenamiento"
            style={{
              minWidth: "44px",
              minHeight: "44px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "rgba(255,255,255,0.2)",
              border: "none",
              borderRadius: "6px",
              color: "#FFFFFF",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <X size={16} strokeWidth={2.5} aria-hidden />
          </button>
        </div>
      )}
    </>
  );
}
