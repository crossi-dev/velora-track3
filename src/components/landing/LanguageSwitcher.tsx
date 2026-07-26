"use client";

import { LOCALE_COOKIE, type Locale } from "@/app/_landing/i18n";

// Next.js App Router i18n cookie pattern:
// https://nextjs.org/docs/app/building-your-application/routing/internationalization
// Originally used router.refresh() to re-run the server component without a
// full navigation. Confirmed live (2026-07-26) that Firebase Hosting's CDN
// (edge node cache-eze2230075-EZE) intermittently 503s the RSC fetch
// router.refresh() issues (Cloud Run logs show the same request landing
// 200 at the origin every time — the failure is CDN-layer only, likely the
// large Next-Router-State-Tree header this specific request carries hitting
// an edge size/timeout limit a plain navigation never triggers). A full
// document reload sidesteps the RSC fetch path entirely and was verified
// reliable — worse than a soft refresh, but it actually works.

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
}: {
  currentLocale: Locale;
  labels: SwitcherLabels;
}) {
  function switchTo(locale: Locale) {
    if (locale === currentLocale) return;
    // Write the NEXT_LOCALE preference cookie.
    // SameSite=Lax: safe for top-level navigations (no CSRF risk for a UI pref).
    document.cookie = `${LOCALE_COOKIE}=${locale}; max-age=${ONE_YEAR}; path=/; SameSite=Lax`;
    // Full reload (not router.refresh()) — see the module comment above.
    window.location.reload();
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
