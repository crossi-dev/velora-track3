// Theme management for Velora v2.
//
// Three modes stored in localStorage under "velora-theme":
//   "light"  — force light
//   "dark"   — force dark
//   "system" — follow prefers-color-scheme (default for first-time users)
//
// The actual application of the theme to <html data-theme="..."> happens
// in two places:
//   1. THEME_BOOT_SCRIPT in src/app/layout.tsx — runs synchronously in
//      the <head> before first paint (no FOUC).
//   2. setTheme() in this module — called from any client interaction
//      that changes the user's preference (e.g. Settings tab toggle).
//
// Keeping the inline script logic in sync with this module's logic is
// the contract: both must produce the same data-theme attribute for the
// same inputs. The script is duplicated as a string because it must
// run before React hydrates.

export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "velora-theme";

export function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore — private browsing, etc. */
  }
  return "system";
}

export function setTheme(mode: ThemeMode): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  applyResolvedTheme(mode);
}

export function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function applyResolvedTheme(mode: ThemeMode): void {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(mode);
  if (resolved === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

/**
 * Inline script body run synchronously in <head> before first paint.
 * Mirrors the logic of getStoredTheme + applyResolvedTheme so the
 * <html data-theme> attribute is correct on the very first render
 * tick — no flash of light theme on dark-mode reload.
 *
 * Keep this string literal in sync with the functions above. Tested
 * by exercising the Settings toggle: refresh after toggle, verify
 * the new theme is applied before any paint.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var k="velora-theme";var v=localStorage.getItem(k);var m=(v==="light"||v==="dark"||v==="system")?v:"system";var d=m==="dark"||(m==="system"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d){document.documentElement.setAttribute("data-theme","dark");}}catch(e){}})();`;
