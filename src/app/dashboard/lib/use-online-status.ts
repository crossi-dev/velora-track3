"use client";

import { useEffect, useState } from "react";

/**
 * Tracks the browser's online/offline state. Returns `true` initially if
 * `navigator.onLine` is true (or if running on the server, where we default
 * to optimistic-online to avoid flashing an offline banner during SSR).
 */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() => {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine !== false;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);

    // Reconcile on mount in case navigator.onLine changed before hydration.
    if (typeof navigator !== "undefined") {
      setOnline(navigator.onLine !== false);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  return online;
}
