"use client";

import { isCapacitor, openExternalUrl } from "@/lib/capacitor-helpers";

/**
 * Navigate to an external URL from a user-triggered action.
 *
 * In a browser: creates a hidden <a> and clicks it.
 * In Capacitor: uses the Browser plugin to open in the system browser
 * (so wa.me resolves to WhatsApp, etc.).
 *
 * Returns true if navigation was attempted (does not guarantee success
 * in the Capacitor path since it's async).
 */
export function navigateFromUserAction(url: string): boolean {
  if (typeof document === "undefined") return false;

  if (isCapacitor()) {
    // Fire-and-forget — the native browser opens asynchronously
    void openExternalUrl(url);
    return true;
  }

  try {
    const link = document.createElement("a");
    link.href = url;
    link.rel = "noopener noreferrer";
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    return true;
  } catch {
    return false;
  }
}
