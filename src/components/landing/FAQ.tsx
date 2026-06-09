"use client";

import { useRef } from "react";

export type FAQItem = { q: string; a: string };
export type FAQCopy = {
  /** Three-part title: [before, emphasised, after] — e.g. ["Lo que ", "probablemente", " querés saber."]. */
  title: [string, string, string];
  subtitle: string;
  items: FAQItem[];
};

export default function FAQ({ copy }: { copy: FAQCopy }) {
  /* Single-open behaviour. Native <details> + a small handler — no JS lib. */
  const root = useRef<HTMLDivElement>(null);
  const onToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    const t = e.currentTarget;
    if (!t.open || !root.current) return;
    root.current
      .querySelectorAll<HTMLDetailsElement>("details[open]")
      .forEach((d) => {
        if (d !== t) d.open = false;
      });
  };

  return (
    <section
      id="preguntas"
      data-screen-label="FAQ"
      className="py-[clamp(96px,14vw,160px)]"
    >
      <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-[clamp(40px,6vw,80px)] px-[clamp(20px,4vw,56px)] lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <div>
          <h2
            className="m-0 mb-4 text-balance font-[family-name:var(--font-serif)] font-semibold leading-[1.05] tracking-[-0.02em]"
            style={{ fontSize: "clamp(2rem, 4.5vw, 3.25rem)" }}
          >
            {copy.title[0]}
            <em className="font-medium italic text-[color:var(--color-ink-60)]">
              {copy.title[1]}
            </em>
            {copy.title[2]}
          </h2>
          <p className="m-0 max-w-[30ch] text-base text-[color:var(--color-ink-60)]">
            {copy.subtitle}
          </p>
        </div>

        <div ref={root} className="border-t border-[color:var(--color-line)]">
          {copy.items.map((it) => (
            <details
              key={it.q}
              onToggle={onToggle}
              className="group border-b border-[color:var(--color-line)]"
            >
              <summary
                className="flex cursor-pointer list-none items-center justify-between gap-6 px-1 py-7 font-[family-name:var(--font-serif)] font-medium tracking-[-0.01em] text-[color:var(--color-ink)] transition-opacity duration-200 hover:opacity-70 [&::-webkit-details-marker]:hidden"
                style={{ fontSize: "clamp(1.125rem, 1.6vw, 1.375rem)" }}
              >
                <span>{it.q}</span>
                <PlusMinus />
              </summary>
              <div className="overflow-hidden px-1 pb-7 text-[color:var(--color-ink-80)]">
                <div className="faq-answer-inner max-w-[62ch] leading-[1.6]">
                  {it.a}
                </div>
              </div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* Plus that morphs into a minus when the parent <details> is open. */
function PlusMinus() {
  return (
    <span
      aria-hidden
      className="relative block h-7 w-7 flex-none text-[color:var(--color-ink-60)] transition-[transform,color] duration-300 ease-out group-open:text-[color:var(--color-ink)]"
    >
      <span className="absolute top-1/2 right-1 left-1 h-px -translate-y-1/2 bg-current" />
      <span className="absolute top-1 bottom-1 left-1/2 w-px -translate-x-1/2 origin-center bg-current transition-transform duration-300 ease-out group-open:scale-y-0" />
    </span>
  );
}
