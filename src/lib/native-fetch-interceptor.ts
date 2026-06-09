// Client-only module. Patches window.fetch to inject the owner native token
// header on same-origin requests when the app is running in Capacitor Android.
// Also handles the token-refresh response header so the stored token stays
// up-to-date without requiring re-login.
//
// C1: Token storage uses @capacitor/preferences (Android Keystore /
// EncryptedSharedPreferences) instead of localStorage. Platform-branched:
// Preferences on Android/iOS, localStorage on desktop web (where the native
// token does not exist). Tokens previously stored in localStorage will not
// migrate automatically — users must re-login once after this deploy.

import { Capacitor } from "@capacitor/core";

const TOKEN_KEY = "velora_owner_native_token";
const INJECT_HEADER = "x-velora-owner-token";
const REFRESH_HEADER = "x-velora-owner-token-refresh";

function isNativePlatform(): boolean {
  return Capacitor.getPlatform() === "android" || Capacitor.getPlatform() === "ios";
}

// All three storage primitives below tolerate Preferences being unregistered
// in the running APK (older builds shipped without @capacitor/preferences in
// capacitor.plugins.json). On failure we fall back to localStorage so the app
// keeps working until the user installs a rebuilt APK. Without this guard a
// Preferences reject crashes the await chain and silently breaks sign-out and
// any other caller in the auth path.
async function readToken(): Promise<string | null> {
  if (isNativePlatform()) {
    try {
      const { Preferences } = await import("@capacitor/preferences");
      const { value } = await Preferences.get({ key: TOKEN_KEY });
      if (value) return value;
    } catch { /* fall through to localStorage */ }
  }
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

async function writeToken(value: string): Promise<void> {
  if (isNativePlatform()) {
    try {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.set({ key: TOKEN_KEY, value });
      return;
    } catch { /* fall through to localStorage */ }
  }
  if (typeof window !== "undefined") localStorage.setItem(TOKEN_KEY, value);
}

async function removeToken(): Promise<void> {
  if (isNativePlatform()) {
    try {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.remove({ key: TOKEN_KEY });
    } catch { /* fall through to localStorage */ }
  }
  if (typeof window !== "undefined") localStorage.removeItem(TOKEN_KEY);
}

/**
 * Install a window.fetch patch that:
 *   1. Reads the owner native token from Preferences (Android) or localStorage (web).
 *   2. Injects it as `x-velora-owner-token` on every same-origin request.
 *   3. Reads `x-velora-owner-token-refresh` from the response and updates
 *      storage when present (sliding window refresh).
 *
 * Safe to call multiple times — installs only once per page lifecycle.
 * No-op on SSR (typeof window === "undefined").
 */
export function installNativeFetchInterceptor(): void {
  if (typeof window === "undefined") return;

  // Guard against double-installation across React StrictMode double-effects.
  const win = window as typeof window & { __veloraNativeFetchPatched?: boolean };
  if (win.__veloraNativeFetchPatched) return;
  win.__veloraNativeFetchPatched = true;

  const original = window.fetch.bind(window);

  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const token = await readToken();
    if (!token) return original(input, init);

    // Only inject for same-origin requests to avoid leaking the token to
    // third-party endpoints (MP, WhatsApp, Google).
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
    const isSameOrigin =
      rawUrl.startsWith("/") || rawUrl.startsWith(window.location.origin);
    if (!isSameOrigin) return original(input, init);

    // Merge headers without mutating the caller's init object.
    const baseHeaders =
      init?.headers ??
      (input instanceof Request ? input.headers : undefined);
    const headers = new Headers(baseHeaders);
    headers.set(INJECT_HEADER, token);

    const response = await original(input, { ...init, headers });

    // Token refresh: server sends a new token when the current one is near expiry.
    const refreshed = response.headers.get(REFRESH_HEADER);
    if (refreshed) await writeToken(refreshed);

    return response;
  };
}

/**
 * Remove the stored owner native token (Preferences on Android, localStorage on web).
 * Call on sign-out to clear the Capacitor session.
 */
export async function clearNativeToken(): Promise<void> {
  await removeToken();
}

/**
 * Write the owner native token to platform-appropriate storage.
 * Used by the sign-in flow in LandingPage.
 */
export async function storeNativeToken(value: string): Promise<void> {
  await writeToken(value);
}

/**
 * Read the stored owner native token (useful for diagnostics / proactive refresh).
 * Returns null when not in a browser or no token is stored.
 */
export async function getNativeToken(): Promise<string | null> {
  if (typeof window === "undefined") return null;
  return readToken();
}
