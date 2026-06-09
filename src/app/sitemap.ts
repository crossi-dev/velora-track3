import type { MetadataRoute } from "next";

const BASE = "https://somosvelora.com";
const TOOLS = "https://tools.somosvelora.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: BASE, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/privacy`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.3 },
    { url: `${BASE}/terminos`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.3 },
    { url: `${BASE}/terms`, lastModified: new Date(), changeFrequency: "monthly", priority: 0.3 },
    // MCP toolkit landing — discoverable by AI crawlers alongside the main site.
    { url: TOOLS, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
  ];
}
