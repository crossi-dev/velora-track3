"use client";

import { useEffect } from "react";
import { isCapacitor } from "@/lib/capacitor-helpers";

/**
 * Handles Android App Link / deep link returns into the Capacitor app.
 *
 * When the OAuth flow completes in the system browser, Android routes
 * the callback URL (somosvelora.com/api/auth/callback/google?...)
 * back to the app via the App Link intent filter. The Capacitor App
 * plugin fires an "appUrlOpen" event with the URL. We navigate the
 * WebView to that URL so NextAuth can process the callback and set
 * the session cookie inside the WebView context.
 */
export function CapacitorAppLinkHandler() {
  useEffect(() => {
    if (!isCapacitor()) return;

    let cleanup: (() => void) | undefined;

    (async () => {
      try {
        const { App } = await import("@capacitor/app");

        const listener = await App.addListener("appUrlOpen", (event) => {
          // The URL is the full callback URL from the OAuth flow
          // e.g. https://somosvelora.com/api/auth/callback/google?code=...
          const url = event.url;
          if (!url) return;

          try {
            const parsed = new URL(url);
            // Only handle URLs for our own host
            if (
              parsed.hostname === "somosvelora.com" ||
              parsed.hostname === "www.somosvelora.com"
            ) {
              // Navigate the WebView to this URL so the server can
              // process the OAuth callback and set the session cookie
              // inside the WebView's context.
              window.location.href = url;
            }
          } catch {
            // Invalid URL — ignore
          }
        });

        cleanup = () => listener.remove();
      } catch {
        // @capacitor/app not available
      }
    })();

    return () => cleanup?.();
  }, []);

  return null;
}
