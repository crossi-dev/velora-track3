export type QuietRowCopy = {
  /** Exactly 3 short statements. Plain text, no icons. */
  items: [string, string, string];
};

export default function QuietRow({ copy }: { copy: QuietRowCopy }) {
  return (
    <section
      aria-label="Capacidades"
      className="border-y border-[color:var(--color-line)] bg-[color:var(--color-tint)]"
    >
      <div className="mx-auto grid max-w-[1240px] grid-cols-1 px-[clamp(20px,4vw,56px)] md:grid-cols-3">
        {copy.items.map((item, i) => (
          <p
            key={item}
            className={[
              "py-7 text-base tracking-[-0.005em] text-[color:var(--color-ink-80)] md:px-7 md:py-8",
              i > 0
                ? "border-t border-[color:var(--color-line)] md:border-t-0 md:border-l"
                : "",
            ].join(" ")}
          >
            {item}
          </p>
        ))}
      </div>
    </section>
  );
}
