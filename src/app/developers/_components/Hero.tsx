// src/app/developers/_components/Hero.tsx — Hero + verified-facts strip for
// the /developers page. Pure server component, no client JS.
//
// The right-hand panel is an illustrated CSS/markup mockup of a laptop with a
// Claude-style chat open, showing a Velora MCP widget rendered mid-conversation.
// No real product screenshot exists yet (verified: no image assets in
// src/app/developers or public/ for this page) — the mockup is labeled as
// illustrative directly under it, never presented as a captured screenshot.

import { TOTAL_TOOLS, TOOL_PACKS } from "../_lib/tool-catalog";
import { WIDGETS } from "../_lib/widget-catalog";

const STATS = [
  { value: `${TOTAL_TOOLS}`, label: "tools" },
  { value: `${TOOL_PACKS.length}`, label: "capability packs" },
  { value: `${WIDGETS.length}`, label: "widgets interactivos" },
];

function LaptopMockup() {
  return (
    <div aria-hidden className="mx-auto w-full max-w-[26rem] select-none lg:mx-0">
      {/* Screen */}
      <div
        className="overflow-hidden rounded-[1rem] border shadow-[var(--shadow-hero)]"
        style={{
          borderColor: "var(--brand-deep)",
          background: "var(--brand-deep)",
          padding: "0.5rem 0.5rem 0",
        }}
      >
        {/* Browser chrome — pinned to Velora's dark-mode --surface (#15233E), since this
            mockup always renders as a dark chat UI regardless of the page's own theme. */}
        <div className="flex items-center gap-3 rounded-t-[0.5rem] px-3 py-2" style={{ background: "#15233E" }}>
          <div className="flex gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#E17B6B" }} />
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#E0BA5E" }} />
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#5FAE7D" }} />
          </div>
          <div
            className="flex-1 truncate rounded-full px-3 py-1 text-center font-[family-name:var(--font-mono)] text-[0.6875rem]"
            style={{ background: "rgba(250,246,238,0.08)", color: "rgba(250,246,238,0.55)" }}
          >
            claude.ai
          </div>
        </div>

        {/* Chat surface */}
        <div className="flex flex-col gap-3 px-3 pb-3 pt-4" style={{ background: "#0B1628" }}>
          {/* User message */}
          <div className="flex justify-end">
            <div
              className="max-w-[85%] rounded-[var(--radius-lg)] rounded-tr-[var(--radius-xs)] px-3 py-2 text-[0.75rem] leading-[1.4]"
              style={{ background: "var(--accent-cream)", color: "var(--brand-deep)" }}
            >
              Cobrale $18.400 a Fer por 2 alfajores y un café
            </div>
          </div>

          {/* Assistant message + tool call */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 px-0.5">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: "#8AB0F0" }} />
              <span
                className="font-[family-name:var(--font-mono)] text-[0.625rem] uppercase tracking-[0.06em]"
                style={{ color: "rgba(250,246,238,0.45)" }}
              >
                velora · open_payment_link_wizard
              </span>
            </div>

            {/* Rendered widget preview inside the chat — miniature replica of payment-link-wizard.tsx */}
            <div
              className="flex flex-col gap-2 rounded-[var(--radius-lg)] rounded-tl-[var(--radius-xs)] p-3"
              style={{ background: "#1E2F50", border: "1px solid rgba(250,246,238,0.08)" }}
            >
              <p className="m-0 text-[0.75rem] font-semibold" style={{ color: "#F5EFE0" }}>
                Revisá el cobro
              </p>
              <div className="flex items-center justify-between text-[0.6875rem]" style={{ color: "rgba(245,239,224,0.65)" }}>
                <span>Fernanda Ríos</span>
                <span>2× Alfajor · 1× Café</span>
              </div>
              <div
                className="flex items-center justify-between rounded-[var(--radius-md)] px-2.5 py-2"
                style={{ background: "rgba(250,246,238,0.06)" }}
              >
                <span className="text-[0.6875rem]" style={{ color: "rgba(245,239,224,0.65)" }}>Total a cobrar</span>
                <span className="font-[family-name:var(--font-mono)] text-[0.9375rem] font-bold" style={{ color: "#F5EFE0" }}>
                  $ 18.400
                </span>
              </div>
              <div
                className="rounded-[var(--radius-pill)] px-3 py-1.5 text-center text-[0.6875rem] font-semibold"
                style={{ background: "#F5EFE0", color: "var(--brand-deep)" }}
              >
                Confirmar y generar link
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Laptop base */}
      <div
        className="mx-auto h-[0.6rem] w-[92%] rounded-b-[0.4rem]"
        style={{ background: "linear-gradient(180deg, #15233E, #0B1628)" }}
      />
      <div className="mx-auto h-[0.25rem] w-[40%] rounded-b-full" style={{ background: "#0B1628" }} />

      <p className="mt-4 text-center text-[0.75rem] italic leading-[1.5]" style={{ color: "var(--tone-faint)" }}>
        Ilustración del producto — no es una captura de pantalla real.
      </p>
    </div>
  );
}

export function Hero() {
  return (
    <header className="grid grid-cols-1 items-center gap-10 pt-10 pb-10 md:pt-14 md:pb-14 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)] lg:gap-12">
      <div>
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-[color:var(--border)] bg-[color:var(--surface-subtle)] px-3.5 py-1 text-[0.8125rem] text-[color:var(--tone-muted)]">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[color:var(--brand)]" />
          MCP Server &middot; tools.somosvelora.com
        </div>

        <h1
          className="m-0 mb-4 max-w-[20ch] font-[family-name:var(--font-fraunces)] font-medium leading-[1.05] tracking-[-0.02em] text-[color:var(--tone-strong)]"
          style={{ fontSize: "clamp(2.5rem, 6vw, 3.75rem)" }}
        >
          Conectá tu agente de IA <em className="italic text-[color:var(--brand)]">al negocio real</em>.
        </h1>

        <p
          className="m-0 max-w-[52ch] leading-[1.6] text-[color:var(--tone-body)]"
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
      </div>

      <LaptopMockup />
    </header>
  );
}
