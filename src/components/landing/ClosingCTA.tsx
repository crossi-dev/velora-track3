"use client";

import GoogleMark from "./GoogleMark";

export type ClosingCopy = {
  /** Closing headline */
  headline: string;
  /** Button label */
  ctaLabel: string;
  /** Reassurance line under the button, e.g. "Gratis en beta · sin tarjeta" */
  microTrust: string;
};

/**
 * Closing CTA band — the page's second conversion point. A visitor convinced
 * by the FAQ shouldn't have to scroll back to the hero to act.
 */
export default function ClosingCTA({
  copy,
  onSignIn,
}: {
  copy: ClosingCopy;
  onSignIn: () => void | Promise<void>;
}) {
  return (
    <section
      data-screen-label="ClosingCTA"
      className="border-t border-[color:var(--color-line)] bg-[color:var(--color-tint)] py-[clamp(80px,12vw,140px)]"
    >
      <div className="mx-auto flex max-w-[1240px] flex-col items-center gap-8 px-[clamp(20px,4vw,56px)] text-center">
        <h2
          className="m-0 max-w-[20ch] text-balance font-[family-name:var(--font-serif)] font-semibold leading-[1.1] tracking-[-0.02em] text-[color:var(--color-ink)]"
          style={{ fontSize: "clamp(2.25rem, 5vw, 3.5rem)" }}
        >
          {copy.headline}
        </h2>

        <div className="flex flex-col items-center gap-3">
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
          <p
            className="m-0 text-[color:var(--color-ink-60)]"
            style={{ fontSize: "0.875rem" }}
          >
            {copy.microTrust}
          </p>
        </div>
      </div>
    </section>
  );
}
