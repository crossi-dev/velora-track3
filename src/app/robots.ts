import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      // Default: allow everything except private app paths.
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/dashboard", "/api/", "/onboarding"],
      },
      // GPTBot: same restrictions as the default rule.
      {
        userAgent: "GPTBot",
        allow: "/",
        disallow: ["/dashboard", "/api/", "/onboarding"],
      },
      // AI crawlers — explicitly allowed so they index the marketing site
      // and discover the llms.txt / MCP toolkit.
      { userAgent: "ChatGPT-User", allow: "/" },
      { userAgent: "ClaudeBot", allow: "/" },
      { userAgent: "anthropic-ai", allow: "/" },
      { userAgent: "PerplexityBot", allow: "/" },
      { userAgent: "Google-Extended", allow: "/" },
      { userAgent: "Googlebot", allow: "/" },
    ],
    // Both hostnames serve content; declare both sitemaps so crawlers index each.
    sitemap: [
      "https://somosvelora.com/sitemap.xml",
      "https://tools.somosvelora.com/sitemap.xml",
    ],
  };
}
