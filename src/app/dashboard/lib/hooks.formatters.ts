"use client";

import {
  moneyFmt,
  formatNumber,
  formatDate,
  formatTime,
  movementDescriptionLabel,
} from "./helpers";
import type { SiteLocale } from "@/lib/site-locale";
import type { CashMovement } from "./types";

export type DashboardTranslator = (en: string, es: string) => string;

export interface DashboardFormatters {
  moneyFmt: (v: unknown, c: string) => string;
  formatNumber: (v: unknown) => string;
  formatDate: (v: string) => string;
  formatTime: (v: string) => string;
  movementDescriptionLabel: (m: CashMovement) => string;
}

/**
 * Builds the locale-bound formatter bundle exposed on the dashboard state
 * return object. These are the public formatter signatures consumed by
 * component files, so any signature changes here are a breaking API change.
 */
export function buildDashboardFormatters(
  locale: string,
  t: DashboardTranslator
): DashboardFormatters {
  const siteLocale = locale as SiteLocale;
  return {
    moneyFmt: (v: unknown, c: string) => moneyFmt(v, c, siteLocale),
    formatNumber: (v: unknown) => formatNumber(v, siteLocale),
    formatDate: (v: string) => formatDate(v, siteLocale),
    formatTime: (v: string) => formatTime(v, siteLocale),
    movementDescriptionLabel: (m: CashMovement) =>
      movementDescriptionLabel(m, siteLocale, t),
  };
}

/**
 * Assistant-side money formatter. Uses `Intl.NumberFormat` with a caller-provided
 * locale rather than the dashboard state's locale — kept separate so the
 * assistant hook can format in whatever locale the parse context expects.
 */
export function assistantMoneyFmt(n: number, cur: string, loc: string) {
  return n.toLocaleString(loc, { style: "currency", currency: cur || "ARS" });
}
