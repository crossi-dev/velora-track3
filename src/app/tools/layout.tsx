// src/app/tools/layout.tsx — Layout override for the tools.somosvelora.com landing.
//
// Scoped metadata for the /tools route segment. The root layout (app/layout.tsx)
// wraps this with its <html>/<body> — this layout only overrides metadata for
// this segment. No providers or client components needed.

import type { Metadata } from "next";

const TOOLS_URL = "https://tools.somosvelora.com";
const MAIN_URL = "https://somosvelora.com";
const TITLE = "Velora Toolkit — MCP tools para agentes de IA";
// ≤160 chars (verified: 154 chars)
const DESCRIPTION =
  "Velora MCP Server: 45 business tools for AI agents — ARCA invoicing, " +
  "MercadoPago, Andreani shipping, catalog, WhatsApp. Connect any AI to Velora.";

const OG_IMAGE = {
  url: `${MAIN_URL}/opengraph-image`,
  width: 1200,
  height: 630,
  alt: "Velora Toolkit — MCP tools para agentes de IA",
};

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "MCP server",
    "Model Context Protocol",
    "AI agent tools",
    "agentic commerce",
    "ARCA invoicing",
    "MercadoPago API",
    "Andreani API",
    "Argentina",
    "Velora",
  ],
  alternates: {
    canonical: TOOLS_URL,
  },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: TOOLS_URL,
    type: "website",
    siteName: "Velora",
    locale: "es_AR",
    alternateLocale: ["en_US"],
    images: [OG_IMAGE],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
    images: [OG_IMAGE.url],
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function ToolsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
