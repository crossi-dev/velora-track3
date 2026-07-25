// src/app/developers/page.tsx — Developer-facing page for the Velora MCP
// server. Linked from the site footer. Static server component — no
// client JS required. Route convention mirrors the sibling standalone
// content pages (/privacy, /terminos, /terms): own metadata, real design
// tokens via inline style / Tailwind arbitrary values, "Volver a Velora"
// back link, no shared (landing) route-group chrome.

import type { Metadata } from "next";
import { TOTAL_TOOLS, TOOL_PACKS } from "./_lib/tool-catalog";
import { WIDGETS } from "./_lib/widget-catalog";
import { Hero } from "./_components/Hero";
import { ToolPacksSection } from "./_components/ToolPacksSection";
import { WidgetsSection } from "./_components/WidgetsSection";
import { ConnectSection } from "./_components/ConnectSection";

export const dynamic = "force-static";

export const metadata: Metadata = {
  title: "Velora — Para Desarrolladores",
  description:
    "Velora es un servidor MCP que conecta agentes de IA (Claude, ChatGPT, Gemini) a un negocio argentino real: facturación ARCA, pagos, catálogo, ventas, caja, logística y WhatsApp.",
};

// JSON-LD: schema.org/WebAPI — same pattern used by /tools (src/app/tools/page.tsx).
// Source: https://schema.org/WebAPI
interface WebApiLd {
  "@context": string;
  "@type": string;
  name: string;
  description: string;
  documentation: string;
  url: string;
  provider: { "@type": string; name: string; url: string };
  areaServed: { "@type": string; name: string };
}

const WEB_API_LD: WebApiLd = {
  "@context": "https://schema.org",
  "@type": "WebAPI",
  name: "Velora MCP Server",
  description: `Servidor MCP con ${TOTAL_TOOLS} tools en ${TOOL_PACKS.length} packs para comercio agéntico en Argentina: fiscal (ARCA), pagos (MercadoPago), catálogo y stock, ventas y caja, clientes y proveedores, logística (Andreani/PedidosYa) y WhatsApp. Incluye ${WIDGETS.length} widgets interactivos (MCP Apps).`,
  documentation: "https://somosvelora.com/developers",
  url: "https://tools.somosvelora.com/api/mcp",
  provider: {
    "@type": "Organization",
    name: "Velora",
    url: "https://somosvelora.com",
  },
  areaServed: {
    "@type": "Country",
    name: "Argentina",
  },
};

export default function DevelopersPage() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        backgroundColor: "var(--background)",
        backgroundImage:
          "radial-gradient(60rem 30rem at 85% -10%, var(--brand-soft) 0%, transparent 60%)",
        color: "var(--tone-strong)",
        fontFamily: "var(--font-dm-sans), sans-serif",
      }}
    >
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(WEB_API_LD) }}
      />

      <div className="mx-auto max-w-[64rem] px-[clamp(1.25rem,4vw,2rem)]">
        <a
          href="/"
          className="mt-8 inline-flex items-center gap-2 text-[0.875rem] no-underline"
          style={{ color: "var(--brand)" }}
        >
          <img src="/velora-mark.svg" alt="" aria-hidden width={16} height={16} style={{ borderRadius: "4px" }} />
          &larr; Volver a Velora
        </a>

        <Hero />
        <ToolPacksSection />
        <WidgetsSection />
        <ConnectSection />

        <footer className="flex flex-col items-start justify-between gap-3 border-t border-[color:var(--border)] py-8 text-[0.8125rem] text-[color:var(--tone-muted)] sm:flex-row sm:items-center">
          <p className="m-0">
            Velora &mdash;{" "}
            <a href="https://somosvelora.com" style={{ color: "var(--brand)" }}>
              somosvelora.com
            </a>
          </p>
          <nav aria-label="Enlaces legales" className="flex gap-4">
            <a href="/privacy" style={{ color: "var(--tone-muted)" }}>
              Privacidad
            </a>
            <a href="/terminos" style={{ color: "var(--tone-muted)" }}>
              Términos
            </a>
            <a
              href="https://modelcontextprotocol.io"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--tone-muted)" }}
            >
              Spec de MCP
            </a>
          </nav>
        </footer>
      </div>
    </div>
  );
}
