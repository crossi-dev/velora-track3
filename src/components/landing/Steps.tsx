export type StepsCopy = {
  /** Three steps. Verbs are bare — no trailing period. The whitespace is the design. */
  items: { n: string; verb: string }[];
};

export default function Steps({ copy }: { copy: StepsCopy }) {
  return (
    <section
      id="como-funciona"
      data-screen-label="Steps"
      className="pt-[clamp(40px,6vw,56px)] pb-[clamp(96px,14vw,160px)]"
    >
      <div className="mx-auto max-w-[1240px] px-[clamp(20px,4vw,56px)]">
        <div
          role="list"
          className="grid grid-cols-1 gap-12 border-t border-[color:var(--color-line)] md:grid-cols-3 md:gap-0"
        >
          {copy.items.map((s, i) => (
            <div
              key={s.n}
              role="listitem"
              className={[
                "pt-12 pb-2 md:pt-14 md:pr-8 md:pb-6",
                i > 0
                  ? "md:border-l md:border-[color:var(--color-line)] md:pl-8"
                  : "",
              ].join(" ")}
            >
              <p
                className="m-0 mb-7 font-[family-name:var(--font-serif)] font-medium leading-none tracking-[-0.02em] text-[color:var(--color-ink-40)]"
                style={{ fontSize: "clamp(2.5rem, 4vw, 3rem)" }}
              >
                {s.n}
              </p>
              <p
                className="m-0 font-[family-name:var(--font-serif)] font-semibold leading-none tracking-[-0.02em] text-[color:var(--color-ink)]"
                style={{ fontSize: "clamp(1.75rem, 3vw, 2.25rem)" }}
              >
                {s.verb}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
