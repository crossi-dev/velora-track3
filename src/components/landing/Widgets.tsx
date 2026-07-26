export type WidgetStep = {
  /** Step label, e.g. "01" */
  n: string;
  /** Short heading for this widget moment */
  title: string;
  /** Description of what the widget shows / lets you do */
  body: string;
};

export type WidgetsCopy = {
  /** Eyebrow label */
  label: string;
  /** Section headline */
  headline: string;
  /** Subcopy that frames the widget experience */
  sub: string;
  /** The interactive moments — 3 steps in the payment commerce loop */
  steps: [WidgetStep, WidgetStep, WidgetStep];
  /** Small disclaimer / placeholder note for future screenshots */
  placeholder?: string;
};

/**
 * "Widgets gráficos" section — shows that Velora is NOT plain text.
 * Describes the interactive commerce loop: payment wizard → cobro status → comprobante.
 * No fabricated screenshots — copy describes the experience and a placeholder
 * note is shown until real widget screenshots are available.
 */
export default function Widgets({ copy }: { copy: WidgetsCopy }) {
  return (
    <section
      id="widgets"
      data-screen-label="Widgets"
      aria-labelledby="widgets-headline"
      className="py-[clamp(64px,9vw,96px)] border-t border-[color:var(--color-line)]"
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
            id="widgets-headline"
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

        {/* 3-step widget loop */}
        <div
          role="list"
          className="grid grid-cols-1 gap-12 border-t border-[color:var(--color-line)] md:grid-cols-3 md:gap-0"
        >
          {copy.steps.map((step, i) => (
            <div
              key={step.n}
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
                {step.title}
              </h3>
              <p
                className="m-0 max-w-[34ch] text-pretty leading-[1.55] text-[color:var(--color-ink-80)]"
                style={{ fontSize: "clamp(1rem, 1.4vw, 1.0625rem)" }}
              >
                {step.body}
              </p>
            </div>
          ))}
        </div>

        {/* Placeholder note — shown until real widget screenshots exist */}
        {copy.placeholder && (
          <p
            className="mt-14 rounded-xl border border-dashed border-[color:var(--color-line)] px-6 py-4 text-center leading-[1.55] text-[color:var(--color-ink-60)]"
            style={{ fontSize: "0.875rem" }}
          >
            {copy.placeholder}
          </p>
        )}
      </div>
    </section>
  );
}
