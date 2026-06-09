"use client";

import { useRouter } from "next/navigation";
import { LOCALE_COOKIE, type Locale } from "@/app/_landing/i18n";

// Next.js App Router i18n cookie pattern:
// https://nextjs.org/docs/app/building-your-application/routing/internationalization
// Set NEXT_LOCALE cookie client-side → router.refresh() re-runs the server
// component which calls pickLocale() with the new cookie value → locale switches
// without a full navigation.

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
  const router = useRouter();

  function switchTo(locale: Locale) {
    if (locale === currentLocale) return;
    // Write the NEXT_LOCALE preference cookie.
    // SameSite=Lax: safe for top-level navigations (no CSRF risk for a UI pref).
    document.cookie = `${LOCALE_COOKIE}=${locale}; max-age=${ONE_YEAR}; path=/; SameSite=Lax`;
    // Re-run the server component tree so pickLocale() picks up the new cookie.
    router.refresh();
  }

  return (
    <nav aria-label={labels.aria} className="flex items-center gap-1">
      {SUPPORTED.map((locale, i) => (
        <span key={locale} className="flex items-center">
          {i > 0 && (
            <span aria-hidden className="mx-1 text-[color:var(--color-ink-40)] text-xs select-none">
              /
            </span>
          )}
          <button
            type="button"
            onClick={() => switchTo(locale)}
            aria-current={locale === currentLocale ? "true" : undefined}
            className={[
              "text-[0.8125rem] transition-colors duration-200",
              locale === currentLocale
                ? "font-semibold text-[color:var(--color-ink)] cursor-default"
                : "text-[color:var(--color-ink-60)] hover:text-[color:var(--color-ink)]",
            ].join(" ")}
          >
            {locale === "es-AR" ? labels.es : labels.en}
          </button>
        </span>
      ))}
    </nav>
  );
}
