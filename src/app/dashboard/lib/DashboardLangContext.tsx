"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

const LANG_STORAGE_KEY = "velora-lang";
export type DashboardLang = "es-AR" | "en";

function readStoredLang(): DashboardLang {
  if (typeof window === "undefined") return "es-AR";
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY);
    if (stored === "en") return "en";
    if (stored === "es-AR") return "es-AR";
    // Default to Spanish on first visit. English is opt-in via Ajustes →
    // Idioma. Previously this auto-detected `navigator.language` and flipped
    // to English for any en-* browser locale, which surfaced an English UI
    // for a Spanish-default product (target launch is AR-first; English
    // toggle is reserved for the post-demo English variant).
  } catch { /* ignore */ }
  return "es-AR";
}

interface DashboardLangCtx {
  lang: DashboardLang;
  setLang: (lang: DashboardLang) => void;
  t: (en: string, es: string) => string;
}

const DashboardLangContext = createContext<DashboardLangCtx>({
  lang: "es-AR",
  setLang: () => {},
  t: (_en, es) => es,
});

export function DashboardLangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<DashboardLang>(readStoredLang);

  const setLang = useCallback((newLang: DashboardLang) => {
    setLangState(newLang);
    try {
      localStorage.setItem(LANG_STORAGE_KEY, newLang);
      document.cookie = `NEXT_LOCALE=${newLang}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    } catch { /* ignore */ }
  }, []);

  const t = useCallback((en: string, es: string): string => {
    return lang === "en" ? en : es;
  }, [lang]);

  return (
    <DashboardLangContext.Provider value={{ lang, setLang, t }}>
      {children}
    </DashboardLangContext.Provider>
  );
}

export function useDashboardLang(): DashboardLangCtx {
  return useContext(DashboardLangContext);
}

export function useT(): (en: string, es: string) => string {
  return useContext(DashboardLangContext).t;
}

/** Reads lang from localStorage — safe to call outside React (action handlers, utilities). */
export function tLang(en: string, es: string): string {
  if (typeof window === "undefined") return es;
  try {
    return localStorage.getItem(LANG_STORAGE_KEY) === "en" ? en : es;
  } catch {
    return es;
  }
}
