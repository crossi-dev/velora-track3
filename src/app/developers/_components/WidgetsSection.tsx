// src/app/developers/_components/WidgetsSection.tsx — Showcase for the 8
// MCP Apps widgets. No real product screenshots exist yet, so each entry
// renders as a small labeled mockup frame (diagram, not a screenshot) — this
// is disclosed explicitly in the section copy below.

import { TOTAL_TOOLS } from "../_lib/tool-catalog";
import { WIDGETS } from "../_lib/widget-catalog";

function WidgetMockup({ title }: { title: string }) {
  return (
    <div
      aria-hidden
      className="mb-4 overflow-hidden rounded-[var(--radius-md)] border border-dashed border-[color:var(--border-strong)] bg-[color:var(--surface-subtle)]"
    >
      <div className="flex items-center gap-1.5 border-b border-dashed border-[color:var(--border-strong)] px-3 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--tone-faint)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--tone-faint)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--tone-faint)]" />
        <span className="ml-2 truncate text-[0.6875rem] text-[color:var(--tone-faint)]">
          {title}
        </span>
      </div>
      <div className="flex flex-col gap-1.5 p-3">
        <span className="h-2 w-3/4 rounded-full bg-[color:var(--border)]" />
        <span className="h-2 w-1/2 rounded-full bg-[color:var(--border)]" />
        <span className="h-2 w-2/3 rounded-full bg-[color:var(--border)]" />
      </div>
    </div>
  );
}

export function WidgetsSection() {
  return (
    <section aria-labelledby="widgets-headline" className="border-t border-[color:var(--border)] py-12 md:py-16">
      <p className="m-0 mb-2 text-[0.8125rem] font-semibold uppercase tracking-[0.08em] text-[color:var(--tone-muted)]">
        Experiencia
      </p>
      <h2
        id="widgets-headline"
        className="m-0 mb-2 font-[family-name:var(--font-fraunces)] font-medium leading-[1.15] tracking-[-0.015em] text-[color:var(--tone-strong)]"
        style={{ fontSize: "clamp(1.625rem, 3vw, 2.25rem)" }}
      >
        No es texto plano. Son widgets.
      </h2>
      <p className="m-0 mb-3 max-w-[62ch] leading-[1.6] text-[color:var(--tone-muted)]">
        {WIDGETS.length} de las {TOTAL_TOOLS} tools tienen, además, un widget gráfico (MCP Apps) que se
        renderiza adentro del chat — uno a la vez, en el momento exacto en que el negocio lo
        necesita. Nada de tablas de texto crudo para confirmar un cobro.
      </p>
      <p className="m-0 mb-8 max-w-[62ch] text-[0.8125rem] italic leading-[1.5] text-[color:var(--tone-faint)]">
        Los recuadros de abajo son diagramas ilustrativos del contenido de cada widget — no son
        capturas reales de producto.
      </p>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {WIDGETS.map((w) => (
          <div key={w.tool}>
            <WidgetMockup title={w.title} />
            <h3 className="m-0 mb-1 text-[0.9375rem] font-semibold leading-[1.3] text-[color:var(--tone-strong)]">
              {w.title}
            </h3>
            <p className="m-0 mb-1 text-[0.8125rem] leading-[1.45] text-[color:var(--tone-muted)]">
              {w.body}
            </p>
            <code className="font-[family-name:var(--font-mono)] text-[0.75rem] text-[color:var(--tone-faint)]">
              {w.tool}
            </code>
          </div>
        ))}
      </div>
    </section>
  );
}
