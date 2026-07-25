// src/app/developers/_components/WidgetsSection.tsx — Showcase for the 8
// MCP Apps widgets. No real product screenshots exist yet, so each entry
// renders as a small labeled preview card — explicitly disclosed as
// illustrative, never claimed as a real screenshot.
//
// Rendered as a horizontal scroll-snap shelf (not a 4-column static grid):
// each card mimics the widget's own chat-surface chrome and uses the SAME
// semantic accent color the real widget uses at runtime (success/warning/
// brand/neutral — see widget-catalog.ts `accent`), so the preview is a
// faithful miniature of the real state language, not a generic wireframe.

import type { CSSProperties } from "react";
import { TOTAL_TOOLS } from "../_lib/tool-catalog";
import { WIDGETS, type WidgetEntry } from "../_lib/widget-catalog";

const ACCENT_STYLE: Record<WidgetEntry["accent"], CSSProperties> = {
  brand: { color: "var(--brand)", background: "var(--brand-soft)" },
  success: { color: "var(--success)", background: "var(--success-soft)" },
  warning: { color: "var(--warning)", background: "var(--warning-soft)" },
  neutral: { color: "var(--tone-muted)", background: "var(--surface-subtle)" },
};

function WidgetPreviewCard({ widget }: { widget: WidgetEntry }) {
  const accentStyle = ACCENT_STYLE[widget.accent];
  return (
    <article
      className="flex w-[15.5rem] shrink-0 snap-start flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[color:var(--border)] bg-[color:var(--surface)] shadow-[var(--shadow-sm)]"
    >
      {/* Mini chat-surface chrome — echoes the hero laptop mockup for visual continuity */}
      <div className="flex items-center gap-1.5 border-b border-[color:var(--border)] bg-[color:var(--surface-subtle)] px-3 py-2">
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--tone-faint)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--tone-faint)]" />
        <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--tone-faint)]" />
        <span className="ml-1.5 truncate font-[family-name:var(--font-mono)] text-[0.625rem] text-[color:var(--tone-faint)]">
          velora widget
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <h3 className="m-0 text-[0.9375rem] font-semibold leading-[1.3] text-[color:var(--tone-strong)]">
          {widget.title}
        </h3>
        <p className="m-0 min-h-[3.6em] text-[0.8125rem] leading-[1.45] text-[color:var(--tone-muted)]">
          {widget.body}
        </p>
        <span
          className="inline-flex w-fit items-center rounded-[var(--radius-pill)] px-2.5 py-1 text-[0.75rem] font-medium"
          style={accentStyle}
        >
          {widget.preview}
        </span>
      </div>

      <code className="border-t border-[color:var(--border)] bg-[color:var(--surface-subtle)] px-3 py-2 font-[family-name:var(--font-mono)] text-[0.6875rem] text-[color:var(--tone-faint)]">
        {widget.tool}
      </code>
    </article>
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
        Las tarjetas de abajo son previews ilustrativos del contenido de cada widget — no son
        capturas reales de producto.
      </p>

      <div className="relative -mx-[clamp(1.25rem,4vw,2rem)] px-[clamp(1.25rem,4vw,2rem)]">
        <div className="scrollbar-none flex snap-x snap-mandatory gap-4 overflow-x-auto pb-3">
          {WIDGETS.map((w) => (
            <WidgetPreviewCard key={w.tool} widget={w} />
          ))}
        </div>
        {/* Edge fade hints that the shelf scrolls — decorative only */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 hidden w-16 sm:block"
          style={{ background: "linear-gradient(90deg, transparent, var(--background))" }}
        />
      </div>
    </section>
  );
}
