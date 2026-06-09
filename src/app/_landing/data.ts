import type { Locale } from "./i18n";

export const WA_NUMBER = "5490000000000";

/* C6 fix: locale-aware JSON-LD — was hardcoded es-AR description for both locales.
   Now returns a @graph array (Organization + SoftwareApplication) with
   agentic-commerce-E2E framing per Schema.org best practice for multi-type markup. */
export function buildJsonLd(locale: Locale): string {
  const base = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": "https://somosvelora.com/#org",
        name: "Velora",
        url: "https://somosvelora.com",
        sameAs: ["https://tools.somosvelora.com"],
        countryOfOrigin: { "@type": "Country", name: "Argentina" },
      },
      locale === "en"
        ? {
            "@type": "SoftwareApplication",
            name: "Velora",
            operatingSystem: "Web",
            applicationCategory: "BusinessApplication",
            offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
            description:
              "Agentic commerce platform — end-to-end. An AI agent sells, charges, invoices and ships autonomously, coordinating agent-to-agent over A2A. 45-tool MCP server at tools.somosvelora.com.",
            url: "https://somosvelora.com",
            inLanguage: "en-US",
            provider: { "@id": "https://somosvelora.com/#org" },
          }
        : {
            "@type": "SoftwareApplication",
            name: "Velora",
            operatingSystem: "Web",
            applicationCategory: "BusinessApplication",
            offers: { "@type": "Offer", price: "0", priceCurrency: "ARS" },
            description:
              "Plataforma de comercio agéntico de punta a punta. Un agente de IA vende, cobra, factura y despacha de forma autónoma, coordinándose agente a agente vía A2A. Servidor MCP con 45 herramientas en tools.somosvelora.com.",
            url: "https://somosvelora.com",
            inLanguage: "es-AR",
            provider: { "@id": "https://somosvelora.com/#org" },
          },
    ],
  };
  return JSON.stringify(base);
}
