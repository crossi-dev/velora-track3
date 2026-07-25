// src/app/developers/_components/ToolPacksSection.tsx — Tool pack ledger.
//
// Deliberately NOT a 3-column card grid: a single-column indexed list reads
// like a spec sheet / table of contents (large serif index numerals, tools
// as wrapping mono chips) rather than a repeated SaaS "feature card" pattern.

import { TOOL_PACKS, TOTAL_TOOLS } from "../_lib/tool-catalog";

export function ToolPacksSection() {
  return (
    <section aria-labelledby="packs-headline" className="border-t border-[color:var(--border)] py-12 md:py-16">
      <p className="m-0 mb-2 text-[0.8125rem] font-semibold uppercase tracking-[0.08em] text-[color:var(--tone-muted)]">
        Qué incluye
      </p>
      <h2
        id="packs-headline"
        className="m-0 mb-2 font-[family-name:var(--font-fraunces)] font-medium leading-[1.15] tracking-[-0.015em] text-[color:var(--tone-strong)]"
        style={{ fontSize: "clamp(1.625rem, 3vw, 2.25rem)" }}
      >
        {TOTAL_TOOLS} tools, {TOOL_PACKS.length} packs de capacidades.
      </h2>
      <p className="m-0 mb-10 max-w-[60ch] leading-[1.6] text-[color:var(--tone-muted)]">
        Cada pack cubre una parte del ciclo comercial. El agente conectado ve todas las tools
        disponibles y las invoca según lo que el negocio necesite en cada momento.
      </p>

      <ol className="m-0 flex list-none flex-col p-0">
        {TOOL_PACKS.map(({ pack, subtitle, tools }, i) => (
          <li
            key={pack}
            className="group grid grid-cols-[3.25rem_1fr] gap-x-4 gap-y-3 border-t border-[color:var(--border)] py-6 transition-colors first:border-t-0 sm:grid-cols-[4rem_minmax(0,14rem)_1fr] sm:gap-x-6"
          >
            <span
              aria-hidden
              className="font-[family-name:var(--font-fraunces)] italic leading-none text-[color:var(--brand-soft)] transition-colors group-hover:text-[color:var(--brand)]"
              style={{ fontSize: "clamp(1.75rem, 3.5vw, 2.5rem)" }}
            >
              {String(i + 1).padStart(2, "0")}
            </span>

            <div>
              <h3 className="m-0 mb-1 text-[0.9375rem] font-semibold leading-[1.3] text-[color:var(--tone-strong)]">
                {pack}
              </h3>
              <p className="m-0 text-[0.8125rem] leading-[1.45] text-[color:var(--tone-muted)]">
                {subtitle}
              </p>
              <span className="mt-2 inline-block font-[family-name:var(--font-mono)] text-[0.6875rem] text-[color:var(--tone-faint)]">
                {tools.length} tool{tools.length !== 1 ? "s" : ""}
              </span>
            </div>

            <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0 sm:justify-end sm:self-start">
              {tools.map((tool) => (
                <li
                  key={tool.name}
                  className="rounded-[var(--radius-sm)] border border-[color:var(--border)] bg-[color:var(--surface)] px-2 py-1 font-[family-name:var(--font-mono)] text-[0.75rem] leading-none text-[color:var(--tone-body)]"
                >
                  {tool.name}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </section>
  );
}
