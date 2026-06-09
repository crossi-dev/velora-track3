"use client";

import GoogleMark from "./GoogleMark";
import HeroVisual from "./HeroVisual";

const DEFAULT_IMAGE_ALT =
  "Velora en uso: el dueño pregunta por un producto y ve su catálogo en el chat";

export type HeroCopy = {
  /** Giant wordmark. Conventionally uppercase. */
  wordmark: string;
  /** Italic verb directly under the wordmark, e.g. "Conectate." */
  verb: string;
  tagline: string;
  /** Bolded clause at the end of the tagline, e.g. "100% AI Native." */
  taglineStrong: string;
  ctaLabel: string;
  /** Optional reassurance line under the CTA, e.g. "Gratis en beta · sin tarjeta". */
  ctaMicroTrust?: string;
  /** Optional alt text for the app screenshot. Falls back to a sensible default. */
  imageAlt?: string;
};

export default function Hero({
  copy,
  onSignIn,
}: {
  copy: HeroCopy;
  onSignIn: () => void | Promise<void>;
}) {
  return (
    <section
      aria-labelledby="hero-title"
      data-screen-label="Hero"
      className="relative flex min-h-[80vh] items-center overflow-x-clip pt-[104px] pb-[72px] md:min-h-screen md:pt-[120px] md:pb-[96px]"
      style={{
        background:
          "linear-gradient(180deg, var(--color-bg) 0%, var(--color-bg) 55%, rgba(27,58,107,.035) 100%)",
      }}
    >
      <div className="mx-auto grid w-full max-w-[1240px] items-center gap-[clamp(40px,5vw,72px)] px-[clamp(20px,4vw,56px)] md:grid-cols-[minmax(0,1.05fr)_minmax(280px,400px)]">
        {/* Text column — wordmark, verb, tagline, CTA */}
        <div className="grid gap-[clamp(28px,4vw,48px)]">
          {/* Wordmark + italic verb */}
          <div>
            <h1
              id="hero-title"
              className="m-0 font-[family-name:var(--font-serif)] font-semibold text-[color:var(--color-ink)]"
              style={{
                fontSize: "clamp(4rem, 10vw, 8rem)",
                lineHeight: 0.92,
                letterSpacing: "-0.02em",
              }}
            >
              {copy.wordmark}
            </h1>
            <p
              className="m-0 font-[family-name:var(--font-serif)] italic text-[color:var(--color-ink)]"
              style={{
                fontWeight: 500,
                fontSize: "clamp(2rem, 5.5vw, 4rem)",
                lineHeight: 1,
                letterSpacing: "-0.015em",
              }}
            >
              {copy.verb}
            </p>
          </div>

          {/* Tagline + single CTA. No caption, no secondary action — by design. */}
          <div className="grid gap-8">
            <p
              className="m-0 max-w-[38ch] text-pretty leading-[1.55] text-[color:var(--color-ink-80)]"
              style={{ fontSize: "clamp(1.0625rem, 1.5vw, 1.25rem)" }}
            >
              {copy.tagline}{" "}
              <strong className="font-medium text-[color:var(--color-ink)]">
                {copy.taglineStrong}
              </strong>
            </p>

            <div className="flex flex-col items-start gap-3 self-start">
              <button
                type="button"
                onClick={() => onSignIn()}
                aria-label={copy.ctaLabel}
                className="inline-flex items-center gap-3.5 rounded-full bg-[color:var(--color-ink)] py-[18px] pr-7 pl-[22px] text-base font-medium tracking-[-0.005em] text-[color:var(--color-bg)] shadow-[0_1px_0_rgba(27,58,107,.10),0_10px_24px_-12px_rgba(27,58,107,.4)] transition-[transform,box-shadow,opacity] duration-300 ease-out hover:-translate-y-px hover:opacity-90 hover:shadow-[0_1px_0_rgba(27,58,107,.10),0_18px_32px_-14px_rgba(27,58,107,.55)] active:translate-y-0 focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[color:var(--color-ink)]"
              >
                <span className="grid h-[22px] w-[22px] flex-none place-items-center rounded-full" style={{ backgroundColor: "#fff" }}>
                  <GoogleMark />
                </span>
                <span>{copy.ctaLabel}</span>
              </button>
              {copy.ctaMicroTrust && (
                <p
                  className="m-0 pl-1 text-[color:var(--color-ink-60)]"
                  style={{ fontSize: "0.875rem" }}
                >
                  {copy.ctaMicroTrust}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* App screenshot — "see Velora in use" above the fold */}
        <div className="md:justify-self-end">
          <HeroVisual alt={copy.imageAlt ?? DEFAULT_IMAGE_ALT} />
        </div>
      </div>
    </section>
  );
}
