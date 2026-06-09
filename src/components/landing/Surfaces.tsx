export type SurfaceEntry = {
  /** Display name, e.g. "Velora App" */
  name: string;
  /** Short description of this surface */
  description: string;
  /** Availability badge — e.g. "Disponible" or "Próximamente" */
  badge: string;
  /** Whether the badge signals availability (true) or coming-soon (false) */
  available: boolean;
  /** Optional CTA label. When absent, no link is rendered. */
  ctaLabel?: string;
  /** Optional href. Required when ctaLabel is set. */
  ctaHref?: string;
};

export type SurfacesCopy = {
  /** Eyebrow label */
  label: string;
  /** Section headline */
  headline: string;
  /** Subcopy */
  sub: string;
  /** The 3 surface entries */
  entries: [SurfaceEntry, SurfaceEntry, SurfaceEntry];
};

/**
 * "3 surfaces" section — Standalone app, ChatGPT connector, Claude / Cowork
 * connector. Equal visual weight for each; no hierarchy between them.
 * Status badge ("Disponible" / "Próximamente") is the only differentiator.
 */
export default function Surfaces({ copy }: { copy: SurfacesCopy }) {
  return (
    <section
      id="superficies"
      data-screen-label="Surfaces"
      aria-labelledby="surfaces-headline"
      className="py-[clamp(96px,14vw,160px)] border-t border-[color:var(--color-line)]"
    >
      <div className="mx-auto max-w-[1240px] px-[clamp(20px,4vw,56px)]">
        {/* Eyebrow */}
        <p
          className="m-0 mb-5 font-medium uppercase tracking-[0.12em] text-[color:var(--color-ink-60)]"
          style={{ fontSize: "0.875rem" }}
        >
          {copy.label}
        </p>

        {/* Headline + sub */}
        <div className="mb-[clamp(48px,8vw,80px)] grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
          <h2
            id="surfaces-headline"
            className="m-0 text-balance font-[family-name:var(--font-serif)] font-semibold leading-[1.1] tracking-[-0.02em] text-[color:var(--color-ink)]"
            style={{ fontSize: "clamp(2rem, 4.5vw, 3.25rem)" }}
          >
            {copy.headline}
          </h2>
          <p
            className="m-0 self-end text-pretty leading-[1.55] text-[color:var(--color-ink-80)]"
            style={{ fontSize: "clamp(1rem, 1.4vw, 1.125rem)" }}
          >
            {copy.sub}
          </p>
        </div>

        {/* 3 equal cards */}
        <div role="list" className="grid grid-cols-1 gap-6 md:grid-cols-3">
          {copy.entries.map((entry) => (
            <SurfaceCard key={entry.name} entry={entry} />
          ))}
        </div>
      </div>
    </section>
  );
}

function SurfaceCard({ entry }: { entry: SurfaceEntry }) {
  return (
    <article
      role="listitem"
      className="flex flex-col gap-6 rounded-2xl border border-[color:var(--color-line)] bg-[color:var(--color-tint)] px-7 py-8 transition-shadow duration-300 hover:shadow-[0_8px_32px_-8px_rgba(27,58,107,.18)]"
    >
      {/* Badge */}
      <span
        className={[
          "inline-flex self-start rounded-full px-3 py-1 font-medium leading-none",
          entry.available
            ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
            : "bg-[color:var(--color-tint)] text-[color:var(--color-ink-60)] border border-[color:var(--color-line)]",
        ].join(" ")}
        style={{ fontSize: "0.8125rem" }}
      >
        {entry.badge}
      </span>

      {/* Name + description */}
      <div className="flex-1">
        <h3
          className="m-0 mb-3 font-[family-name:var(--font-serif)] font-semibold leading-[1.15] tracking-[-0.015em] text-[color:var(--color-ink)]"
          style={{ fontSize: "clamp(1.375rem, 2.4vw, 1.75rem)" }}
        >
          {entry.name}
        </h3>
        <p
          className="m-0 max-w-[34ch] text-pretty leading-[1.55] text-[color:var(--color-ink-80)]"
          style={{ fontSize: "clamp(1rem, 1.4vw, 1.0625rem)" }}
        >
          {entry.description}
        </p>
      </div>

      {/* Optional CTA link */}
      {entry.ctaLabel && entry.ctaHref && (
        <a
          href={entry.ctaHref}
          className="inline-flex items-center gap-1.5 self-start font-medium text-[color:var(--color-ink)] underline underline-offset-4 decoration-[color:var(--color-ink-40)] transition-[text-decoration-color] duration-200 hover:decoration-[color:var(--color-ink)]"
          style={{ fontSize: "0.9375rem" }}
          {...(!entry.available ? { "aria-disabled": "true" } : {})}
        >
          {entry.ctaLabel}
          <svg
            aria-hidden
            width="14"
            height="14"
            viewBox="0 0 14 14"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M3 7h8M7 3l4 4-4 4"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </a>
      )}
    </article>
  );
}
