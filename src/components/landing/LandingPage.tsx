import Header from "./Header";
import Hero from "./Hero";
import Benefits from "./Benefits";
import Steps from "./Steps";
import Surfaces from "./Surfaces";
import Widgets from "./Widgets";
import QuietRow from "./QuietRow";
import Integraciones from "./Integraciones";
import FAQ from "./FAQ";
import ClosingCTA from "./ClosingCTA";
import Footer from "./Footer";
import type { Locale } from "@/app/_landing/i18n";
import { type LandingCopy, defaultCopy, defaultCopyEn } from "./landing-copy";

export type { LandingCopy };
export { defaultCopy, defaultCopyEn };

/** Returns the correct copy object for the given locale. */
export function getCopy(locale: Locale): LandingCopy {
  return locale === "en" ? defaultCopyEn : defaultCopy;
}

export type LandingPageProps = {
  /** Server action or client handler bound to the single CTA. */
  onSignIn: () => void | Promise<void>;
  /** Override any section of copy. */
  copy?: LandingCopy;
  /** Active locale — used to render the correct active state in the switcher. */
  locale?: Locale;
  /** Client-side locale switch — no server round-trip. See LanguageSwitcher.tsx. */
  onLocaleChange?: (locale: Locale) => void;
};

export default function LandingPage({
  onSignIn,
  copy = defaultCopy,
  locale,
  onLocaleChange,
}: LandingPageProps) {
  // Theme isolation lives in src/app/(landing)/layout.tsx via
  // `color-scheme: light only` — no inline overrides needed here.
  return (
    <>
      <Header copy={copy.header} locale={locale} onSignIn={onSignIn} onLocaleChange={onLocaleChange} />
      <main id="main-content">
        <Hero copy={copy.hero} onSignIn={onSignIn} />
        <Steps copy={copy.steps} />
        <Benefits copy={copy.benefits} />
        <Surfaces copy={copy.surfaces} onSignIn={onSignIn} />
        <Widgets copy={copy.widgets} />
        <Integraciones copy={copy.integraciones} />
        <FAQ copy={copy.faq} />
        <QuietRow copy={copy.quiet} />
        <ClosingCTA copy={copy.closing} onSignIn={onSignIn} />
      </main>
      <Footer copy={copy.footer} />
    </>
  );
}
