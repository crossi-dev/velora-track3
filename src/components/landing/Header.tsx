"use client";

import { useEffect, useState } from "react";
import LanguageSwitcher, { type SwitcherLabels } from "./LanguageSwitcher";
import type { Locale } from "@/app/_landing/i18n";

export type HeaderCopy = {
  wordmark: string;
  nav: { label: string; href: string }[];
  /** Optional — if provided, renders the language switcher in the header. */
  switcher?: SwitcherLabels;
  /** Optional — sticky CTA label, e.g. "Empezá gratis". Needs onSignIn to render. */
  cta?: string;
};

/**
 * Sticky header. Transparent at the top of the page, frosts to a
 * translucent cream when the user scrolls past ~8px.
 */
export default function Header({
  copy,
  locale,
  onSignIn,
}: {
  copy: HeaderCopy;
  locale?: Locale;
  onSignIn?: () => void | Promise<void>;
}) {
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={[
        "fixed inset-x-0 top-0 z-50 transition-[background-color,backdrop-filter,border-color] duration-300",
        "border-b",
        solid
          ? "bg-[color:var(--color-bg)]/80 backdrop-blur-md backdrop-saturate-150 border-[color:var(--color-line)]"
          : "border-transparent",
      ].join(" ")}
      data-screen-label="Header"
    >
      <div className="mx-auto flex h-[72px] max-w-[1240px] items-center justify-between px-[clamp(20px,4vw,56px)]">
        <a
          href="/"
          aria-label={`${copy.wordmark} — inicio`}
          className="font-[family-name:var(--font-serif)] text-2xl font-semibold tracking-[-0.01em] text-[color:var(--color-ink)]"
        >
          {copy.wordmark}
        </a>

        <div className="flex items-center gap-4 md:gap-9">
          <nav
            aria-label="Navegación principal"
            className="hidden gap-9 md:flex"
          >
            {copy.nav.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="text-[0.9375rem] text-[color:var(--color-ink-80)] transition-colors duration-200 hover:text-[color:var(--color-ink)]"
              >
                {item.label}
              </a>
            ))}
          </nav>
          {copy.switcher && locale && (
            <div className="hidden md:block">
              <LanguageSwitcher currentLocale={locale} labels={copy.switcher} />
            </div>
          )}
          {copy.cta && onSignIn && (
            <button
              type="button"
              onClick={() => onSignIn()}
              className="inline-flex items-center rounded-full bg-[color:var(--color-ink)] px-5 py-2.5 text-[0.9375rem] font-medium tracking-[-0.005em] text-[color:var(--color-bg)] transition-[transform,opacity] duration-200 ease-out hover:-translate-y-px hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-ink)]"
            >
              {copy.cta}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
