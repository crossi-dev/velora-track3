// src/app/tools/page.tsx — Static landing page for tools.somosvelora.com.
//
// Served when the middleware rewrites GET / on the tools.* host to /tools.
// Describes the Velora MCP toolkit to developers and AI agent integrators.
// Pure server component — no client JS required.

export const dynamic = "force-static";

import { TOOL_PACKS, TOTAL_TOOLS } from "./_lib/tool-catalog";
import { ConnectionSection } from "./_lib/connection-section";

// ── Sub-components ────────────────────────────────────────────────────────────

function PageHeader() {
  return (
    <header style={{ marginBottom: "3rem" }}>
      <div
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "0.5rem",
          background: "rgba(99,102,241,0.12)",
          border: "1px solid rgba(99,102,241,0.3)",
          borderRadius: "2rem",
          padding: "0.25rem 0.875rem",
          fontSize: "0.875rem",
          color: "#a5b4fc",
          marginBottom: "1.5rem",
          letterSpacing: "0.01em",
        }}
      >
        <span aria-hidden="true" style={{ fontSize: "0.5rem" }}>&#x25CF;</span>
        MCP Server &middot; tools.somosvelora.com
      </div>
      <h1
        style={{
          fontSize: "clamp(2rem, 5vw, 3rem)",
          fontWeight: 700,
          lineHeight: 1.15,
          margin: "0 0 0.75rem",
          color: "#e8e8f0",
        }}
      >
        Velora Toolkit
      </h1>
      <p
        style={{
          fontSize: "clamp(1.125rem, 2.5vw, 1.375rem)",
          color: "#9ca3af",
          margin: 0,
          lineHeight: 1.5,
        }}
      >
        Las herramientas de tu comercio, para cualquier agente de IA — conectá
        Claude, Codex o Gemini a tu negocio.
      </p>
    </header>
  );
}

function ToolCatalogSection() {
  return (
    <section style={{ marginBottom: "3rem" }}>
      <h2
        style={{
          fontSize: "clamp(1.25rem, 3vw, 1.625rem)",
          fontWeight: 600,
          lineHeight: 1.25,
          margin: "0 0 0.5rem",
          color: "#e8e8f0",
        }}
      >
        Qué incluye
      </h2>
      <p style={{ fontSize: "0.9375rem", color: "#6b7280", margin: "0 0 1.5rem" }}>
        {TOTAL_TOOLS} tools en {TOOL_PACKS.length} packs
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(15rem, 1fr))", gap: "1rem" }}>
        {TOOL_PACKS.map(({ pack, subtitle, tools }) => (
          <div
            key={pack}
            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "0.625rem", padding: "1.125rem 1.25rem" }}
          >
            <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, color: "#a5b4fc", margin: "0 0 0.25rem", lineHeight: 1.3 }}>
              {pack}
            </h3>
            <p style={{ fontSize: "0.8125rem", color: "#4b5563", margin: "0 0 0.75rem", lineHeight: 1.4 }}>
              {subtitle}
            </p>
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: "0.375rem" }}>
              {tools.map((tool) => (
                <li key={tool.name} style={{ fontFamily: "monospace", fontSize: "0.875rem", color: "#9ca3af", lineHeight: 1.4 }}>
                  {tool.name}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

const DIVIDER = (
  <hr style={{ border: "none", borderTop: "1px solid rgba(255,255,255,0.08)", margin: "0 0 3rem" }} />
);

// ── JSON-LD structured data (schema.org/WebAPI) ───────────────────────────────
// Source: https://schema.org/WebAPI — published type for APIs accessible over
// Web/Internet technologies; used in the Google Knowledge Graph Search API
// example. All properties below are real WebAPI/Service/Thing properties.

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
  name: "Velora Toolkit",
  description:
    "MCP server for agentic commerce — 45 tools covering the full end-to-end " +
    "commerce cycle: fiscal (ARCA), payments (MercadoPago), logistics (Andreani), " +
    "sales, wholesale orders, cash register, and WhatsApp messaging. " +
    "Connect any AI agent (Claude, Codex, Gemini) to a complete commerce stack via A2A.",
  documentation: "https://tools.somosvelora.com",
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function ToolsLandingPage() {
  return (
    <div style={{ minHeight: "100vh", background: "#0a0a0f", color: "#e8e8f0", fontFamily: "'Inter', system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
      {/* JSON-LD: schema.org/WebAPI — ingested by Google, Bing, and AI crawlers */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(WEB_API_LD) }}
      />
      <main style={{ maxWidth: "56rem", margin: "0 auto", padding: "clamp(2rem, 6vw, 5rem) clamp(1rem, 4vw, 2rem)" }}>
        <PageHeader />

        <section style={{ marginBottom: "3rem" }}>
          <p style={{ fontSize: "1rem", color: "#d1d5db", lineHeight: 1.75, margin: 0, maxWidth: "48rem" }}>
            Este es un servidor{" "}
            <strong style={{ color: "#e8e8f0" }}>MCP (Model Context Protocol)</strong> que
            expone el stack de comercio agéntico de Velora a cualquier agente de IA &mdash;
            comunicación máquina a máquina, no un sitio para navegar manualmente.
            Los clientes MCP se conectan y obtienen{" "}
            <strong style={{ color: "#e8e8f0" }}>{TOTAL_TOOLS} tools</strong> listas para invocar:
            facturación electrónica ARCA, pagos con MercadoPago, logística multi-courier,
            catálogo de productos, pedidos mayoristas, caja y mensajería WhatsApp — todo el
            ciclo de comercio de punta a punta.
          </p>
        </section>

        {DIVIDER}
        <ConnectionSection />
        {DIVIDER}
        <ToolCatalogSection />

        <footer style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: "2rem", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem" }}>
          <p style={{ margin: 0, fontSize: "0.875rem", color: "#4b5563" }}>
            Velora &copy; {new Date().getFullYear()}
          </p>
          <a
            href="https://modelcontextprotocol.io"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: "0.875rem", color: "#6b7280", textDecoration: "none", borderBottom: "1px solid rgba(107,114,128,0.4)", paddingBottom: "1px" }}
          >
            Model Context Protocol spec
          </a>
        </footer>
      </main>
    </div>
  );
}
