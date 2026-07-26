"use client";

import { LOCALE_COOKIE, type Locale } from "@/app/_landing/i18n";

// Next.js App Router i18n cookie pattern:
// https://nextjs.org/docs/app/building-your-application/routing/internationalization
//
// History (both prior approaches confirmed broken live, 2026-07-26):
//   1. router.refresh() — Firebase Hosting's CDN intermittently 503'd the RSC
//      fetch this issues (Cloud Run logs showed the same request landing 200
//      at the origin every time — CDN-layer only).
//   2. window.location.reload() — worked around the 503, but a server-side
//      diagnostic log (LANDING_LOCALE_DEBUG) proved the Cookie header never
//      reaches the origin at all on a real top-level navigation to "/"
//      (rawCookiePresent: false) — some layer between the browser and Cloud
//      Run strips it. A curl test that appeared to "work" was a false
//      positive: curl sent no Accept-Language header, so pickLocale() fell
//      through to its es-AR DEFAULT, not because the cookie was forwarded.
//
// Fix: switch instantly via the onLocaleChange callback (client state, no
// server round-trip at all) instead of depending on the cookie ever
// reaching the origin. The cookie is still written for the rare case a
// future request DOES carry it, but nothing depends on it doing so anymore.

const SUPPORTED: Locale[] = ["es-AR", "en"];
const ONE_YEAR = 60 * 60 * 24 * 365;

export type SwitcherLabels = {
  /** Label for the Spanish option (shown in both locales) */
  es: string;
  /** Label for the English option (shown in both locales) */
  en: string;
  /** aria-label for the switcher nav landmark */
  aria: string;
};

export default function LanguageSwitcher({
  currentLocale,
  labels,
  onLocaleChange,
}: {
  currentLocale: Locale;
  labels: SwitcherLabels;
  /** Client-side locale switch — no server round-trip. See module comment. */
  onLocaleChange?: (locale: Locale) => void;
}) {
  function switchTo(locale: Locale) {
    if (locale === currentLocale) return;
    // Write the NEXT_LOCALE preference cookie — best-effort for the next
    // fresh visit; the switch itself no longer depends on this reaching the
    // server. SameSite=Lax: safe for top-level navigations (no CSRF risk).
    document.cookie = `${LOCALE_COOKIE}=${locale}; max-age=${ONE_YEAR}; path=/; SameSite=Lax`;
    onLocaleChange?.(locale);
  }

  return (
    <nav aria-label={labels.aria} className="flex items-center gap-1">
      {SUPPORTED.map((locale, i) => (
        <span key={locale} className="flex items-center">
          {i > 0 && (
            <span aria-hidden className="mx-1 text-[color:var(--color-ink-40)] select-none" style={{ fontSize: "0.875rem" }}>
              /
            </span>
          )}
          <button
            type="button"
            onClick={() => switchTo(locale)}
            aria-current={locale === currentLocale ? "true" : undefined}
            className={[
              "transition-colors duration-200",
              locale === currentLocale
                ? "font-semibold text-[color:var(--color-ink)] cursor-default"
                : "text-[color:var(--color-ink-60)] hover:text-[color:var(--color-ink)]",
            ].join(" ")}
            style={{ fontSize: "0.875rem" }}
          >
            {locale === "es-AR" ? labels.es : labels.en}
          </button>
        </span>
      ))}
    </nav>
  );
}
