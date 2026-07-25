// src/app/developers/_components/Hero.tsx — Hero + verified-facts strip for
// the /developers page. Pure server component, no client JS.

import { TOTAL_TOOLS, TOOL_PACKS } from "../_lib/tool-catalog";
import { WIDGETS } from "../_lib/widget-catalog";

const STATS = [
  { value: `${TOTAL_TOOLS}`, label: "tools" },
  { value: `${TOOL_PACKS.length}`, label: "capability packs" },
  { value: `${WIDGETS.length}`, label: "widgets interactivos" },
];

export function Hero() {
  return (
    <header className="pt-10 pb-8 md:pt-14 md:pb-10">
      <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[color:var(--border)] bg-[color:var(--surface-subtle)] px-3.5 py-1 text-[0.8125rem] text-[color:var(--tone-muted)]">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[color:var(--brand)]" />
        MCP Server &middot; tools.somosvelora.com
      </div>

      <h1
        className="m-0 mb-4 max-w-[22ch] font-[family-name:var(--font-fraunces)] font-medium leading-[1.08] tracking-[-0.02em] text-[color:var(--tone-strong)]"
        style={{ fontSize: "clamp(2.25rem, 5.5vw, 3.5rem)" }}
      >
        Conectá tu agente de IA <em className="italic text-[color:var(--brand)]">al negocio real</em>.
      </h1>

      <p
        className="m-0 max-w-[62ch] leading-[1.6] text-[color:var(--tone-body)]"
        style={{ fontSize: "clamp(1.0625rem, 1.6vw, 1.25rem)" }}
      >
        Velora es un servidor <strong>MCP</strong> (Model Context Protocol) — el mismo estándar
        abierto que usan Claude, ChatGPT y Gemini — que le da a un agente de IA herramientas
        reales para operar un negocio argentino: facturación fiscal ante ARCA, cobros con
        MercadoPago, catálogo y stock, ventas y caja, clientes y proveedores, logística y
        mensajería por WhatsApp.
      </p>

      <div className="mt-8 flex flex-wrap gap-x-8 gap-y-3 border-t border-[color:var(--border)] pt-6">
        {STATS.map((s) => (
          <div key={s.label} className="flex items-baseline gap-2">
            <span
              className="font-[family-name:var(--font-mono)] font-bold text-[color:var(--brand)]"
              style={{ fontSize: "1.5rem" }}
            >
              {s.value}
            </span>
            <span className="text-[0.875rem] text-[color:var(--tone-muted)]">{s.label}</span>
          </div>
        ))}
      </div>
    </header>
  );
}
