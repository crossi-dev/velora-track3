"use client";

// Hook reactive al estado de la queue offline. Expone `count` (items
// pendientes) y `isOnline` para badges + toasts en el dashboard.
//
// El subscribe + notify se hacen via `subscribe` de offline-queue.ts —
// se dispara cuando enqueue/pop/clear/notifyChanged corren en cualquier
// tab. El listener `online`/`offline` del browser también re-evalúa.

import { useEffect, useState } from "react";
import { getAll, size, subscribe } from "../offline-queue";

export interface OfflineQueueStatus {
  count: number;
  isOnline: boolean;
  lastError: string | null;
}

function readBrowserOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

function readLastError(): string | null {
  const items = getAll();
  for (const item of items) {
    if (item.lastError) return item.lastError;
  }
  return null;
}

export function useOfflineQueueStatus(): OfflineQueueStatus {
  const [count, setCount] = useState(0);
  const [isOnline, setIsOnline] = useState(true);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const refresh = () => {
      setCount(size());
      setIsOnline(readBrowserOnline());
      setLastError(readLastError());
    };

    refresh();
    const unsubscribe = subscribe(refresh);
    const onlineHandler = () => setIsOnline(true);
    const offlineHandler = () => setIsOnline(false);
    window.addEventListener("online", onlineHandler);
    window.addEventListener("offline", offlineHandler);
    return () => {
      unsubscribe();
      window.removeEventListener("online", onlineHandler);
      window.removeEventListener("offline", offlineHandler);
    };
  }, []);

  return { count, isOnline, lastError };
}
