export type BenefitsCopy = {
  /** Eyebrow label, e.g. "Para vos" */
  label: string;
  /** Section headline */
  headline: string;
  /** Three human-benefit items — what the OWNER gains, not what the system does. */
  items: { title: string; body: string }[];
};

/**
 * "Beneficios para vos" — the emotional/benefit section. Sits BEFORE "Cómo
 * funciona" so the visitor learns WHY this matters before HOW it works.
 * Speaks owner outcomes (time, sales while away), not system features.
 */
export default function Benefits({ copy }: { copy: BenefitsCopy }) {
  return (
    <section
      id="capacidades"
      aria-label={copy.label}
      data-screen-label="Benefits"
      className="pt-[clamp(56px,8vw,88px)] pb-[clamp(48px,7vw,72px)] border-t border-[color:var(--color-line)]"
    >
      <div className="mx-auto max-w-[1240px] px-[clamp(20px,4vw,56px)]">
        <p
          className="m-0 mb-5 font-medium uppercase tracking-[0.12em] text-[color:var(--color-ink-60)]"
          style={{ fontSize: "0.875rem" }}
        >
          {copy.label}
        </p>

        <h2
          className="m-0 mb-[clamp(48px,8vw,80px)] max-w-[18ch] text-balance font-[family-name:var(--font-serif)] font-semibold leading-[1.1] tracking-[-0.02em] text-[color:var(--color-ink)]"
          style={{ fontSize: "clamp(2rem, 4.5vw, 3.25rem)" }}
        >
          {copy.headline}
        </h2>

        <div
          role="list"
          className="grid grid-cols-1 gap-12 border-t border-[color:var(--color-line)] md:grid-cols-3 md:gap-0"
        >
          {copy.items.map((b, i) => (
            <div
              key={b.title}
              role="listitem"
              className={[
                "pt-12 md:pt-14 md:pr-8",
                i > 0
                  ? "md:border-l md:border-[color:var(--color-line)] md:pl-8"
                  : "",
              ].join(" ")}
            >
              <h3
                className="m-0 mb-3 font-[family-name:var(--font-serif)] font-semibold leading-[1.15] tracking-[-0.015em] text-[color:var(--color-ink)]"
                style={{ fontSize: "clamp(1.375rem, 2.4vw, 1.75rem)" }}
              >
                {b.title}
              </h3>
              <p
                className="m-0 max-w-[34ch] text-pretty leading-[1.55] text-[color:var(--color-ink-80)]"
                style={{ fontSize: "clamp(1rem, 1.4vw, 1.125rem)" }}
              >
                {b.body}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
