// src/app/developers/_components/ToolPacksSection.tsx — Tool pack grid.

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
      <p className="m-0 mb-8 max-w-[60ch] leading-[1.6] text-[color:var(--tone-muted)]">
        Cada pack cubre una parte del ciclo comercial. El agente conectado ve todas las tools
        disponibles y las invoca según lo que el negocio necesite en cada momento.
      </p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TOOL_PACKS.map(({ pack, subtitle, tools }) => (
          <article
            key={pack}
            className="rounded-[var(--radius-lg)] border border-[color:var(--border)] bg-[color:var(--surface)] p-5"
          >
            <div className="mb-3 flex items-start justify-between gap-2">
              <h3 className="m-0 text-[0.9375rem] font-semibold leading-[1.3] text-[color:var(--brand)]">
                {pack}
              </h3>
              <span className="shrink-0 rounded-full bg-[color:var(--brand-soft)] px-2 py-0.5 font-[family-name:var(--font-mono)] text-[0.75rem] text-[color:var(--brand)]">
                {tools.length}
              </span>
            </div>
            <p className="m-0 mb-3 text-[0.8125rem] leading-[1.4] text-[color:var(--tone-muted)]">
              {subtitle}
            </p>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {tools.map((tool) => (
                <li
                  key={tool.name}
                  className="truncate font-[family-name:var(--font-mono)] text-[0.8125rem] text-[color:var(--tone-body)]"
                >
                  {tool.name}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
