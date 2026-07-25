// build-widget.mjs — bundles ALL MCP App widgets into self-contained HTML strings.
//
// Two compile passes per widget, both in memory, then inlined into a plain HTML template:
//   1. esbuild   → bundles the widget + React + ext-apps into one IIFE <script>.
//   2. PostCSS + @tailwindcss/postcss → compiles widget.css (Tailwind v4) into the
//      <style>, emitting ONLY the utilities the widget uses. The @theme maps every
//      utility to the host's MCP-App CSS variables (chameleon theming).
//
// No external network/asset loading — required for the host's sandboxed iframe.
// Output per widget: src/lib/mcp/widgets/generated/<name>.html.ts (in a
// `generated/` dir so the file-size guardrail skips the large data blob). The
// deploy pipeline is untouched: the HTML ships committed, read as a string at
// runtime (no fs, no build step on Cloud Build).
//
// Run: node scripts/build-widget.mjs   (or npm run build:widget)

import { build } from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const WIDGETS = join(ROOT, "src/lib/mcp/widgets");
const OUT_DIR = join(WIDGETS, "generated");

// ── Widget manifest ───────────────────────────────────────────────────────────
// Add new widgets here. Each entry maps one .tsx source to one .html.ts output.

const WIDGET_LIST = [
  {
    entry: join(WIDGETS, "payment-link-wizard.tsx"),
    cssEntry: join(WIDGETS, "widget.css"),
    outFile: join(OUT_DIR, "payment-link-wizard.html.ts"),
    exportName: "PAYMENT_LINK_WIZARD_HTML",
    title: "Cobro Velora",
    sourceComment: "src/lib/mcp/widgets/payment-link-wizard.tsx + widget.css",
  },
  {
    entry: join(WIDGETS, "catalog-selector.tsx"),
    cssEntry: join(WIDGETS, "widget.css"),
    outFile: join(OUT_DIR, "catalog-selector.html.ts"),
    exportName: "CATALOG_SELECTOR_HTML",
    title: "Catálogo Velora",
    sourceComment: "src/lib/mcp/widgets/catalog-selector.tsx + widget.css",
  },
  {
    entry: join(WIDGETS, "pending-orders.tsx"),
    cssEntry: join(WIDGETS, "widget.css"),
    outFile: join(OUT_DIR, "pending-orders.html.ts"),
    exportName: "PENDING_ORDERS_HTML",
    title: "Cobros pendientes Velora",
    sourceComment: "src/lib/mcp/widgets/pending-orders.tsx + widget.css",
  },
  {
    entry: join(WIDGETS, "cobro-status.tsx"),
    cssEntry: join(WIDGETS, "widget.css"),
    outFile: join(OUT_DIR, "cobro-status.html.ts"),
    exportName: "COBRO_STATUS_HTML",
    title: "Estado del cobro Velora",
    sourceComment: "src/lib/mcp/widgets/cobro-status.tsx + widget.css",
  },
  {
    entry: join(WIDGETS, "delivery-receipt.tsx"),
    cssEntry: join(WIDGETS, "widget.css"),
    outFile: join(OUT_DIR, "delivery-receipt.html.ts"),
    exportName: "DELIVERY_RECEIPT_HTML",
    title: "Comprobante y envío Velora",
    sourceComment: "src/lib/mcp/widgets/delivery-receipt.tsx + widget.css",
  },
  {
    entry: join(WIDGETS, "onboarding.tsx"),
    cssEntry: join(WIDGETS, "widget.css"),
    outFile: join(OUT_DIR, "onboarding.html.ts"),
    exportName: "ONBOARDING_HTML",
    title: "Conectá tu negocio — Velora",
    sourceComment: "src/lib/mcp/widgets/onboarding.tsx + widget.css",
  },
  {
    entry: join(WIDGETS, "sale-confirm.tsx"),
    cssEntry: join(WIDGETS, "widget.css"),
    outFile: join(OUT_DIR, "sale-confirm.html.ts"),
    exportName: "SALE_CONFIRM_HTML",
    title: "Confirmar venta — Velora",
    sourceComment: "src/lib/mcp/widgets/sale-confirm.tsx + widget.css",
  },
  {
    entry: join(WIDGETS, "caja-status.tsx"),
    cssEntry: join(WIDGETS, "widget.css"),
    outFile: join(OUT_DIR, "caja-status.html.ts"),
    exportName: "CAJA_STATUS_HTML",
    title: "Estado de caja — Velora",
    sourceComment: "src/lib/mcp/widgets/caja-status.tsx + widget.css",
  },
  {
    entry: join(WIDGETS, "shipment-prep.tsx"),
    cssEntry: join(WIDGETS, "widget.css"),
    outFile: join(OUT_DIR, "shipment-prep.html.ts"),
    exportName: "SHIPMENT_PREP_HTML",
    title: "Preparar envío — Velora",
    sourceComment: "src/lib/mcp/widgets/shipment-prep.tsx + widget.css",
  },
  {
    entry: join(WIDGETS, "business-overview.tsx"),
    cssEntry: join(WIDGETS, "widget.css"),
    outFile: join(OUT_DIR, "business-overview.html.ts"),
    exportName: "BUSINESS_OVERVIEW_HTML",
    title: "Resumen del negocio — Velora",
    sourceComment: "src/lib/mcp/widgets/business-overview.tsx + widget.css",
  },
];

mkdirSync(OUT_DIR, { recursive: true });

for (const widget of WIDGET_LIST) {
  // ── 1. JS bundle (esbuild) ──────────────────────────────────────────────────
  const jsResult = await build({
    entryPoints: [widget.entry],
    bundle: true,
    format: "iife",
    minify: true,
    write: false,
    platform: "browser",
    target: ["es2020"],
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".tsx": "tsx", ".ts": "ts" },
    // Strip license comments (/* @license … */ blocks in zod/react-dom add ~2KB per widget)
    // and enable aggressive tree-shaking to drop unused exports.
    legalComments: "none",
    treeShaking: true,
  });
  const js = jsResult.outputFiles[0].text;

  // ── 2. CSS bundle (Tailwind v4 via PostCSS) ───────────────────────────────
  const cssInput = readFileSync(widget.cssEntry, "utf-8");
  const cssResult = await postcss([tailwind()]).process(cssInput, { from: widget.cssEntry });
  const css = cssResult.css;

  // ── 3. Inline both into a self-contained HTML shell ───────────────────────
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${widget.title}</title>
<style>${css}</style>
</head>
<body>
<div id="root"></div>
<script>${js}</script>
</body>
</html>`;

  const banner = `// GENERATED by scripts/build-widget.mjs — DO NOT EDIT.
// Source: ${widget.sourceComment}
// Regenerate with: npm run build:widget
/* eslint-disable */
`;
  writeFileSync(
    widget.outFile,
    `${banner}export const ${widget.exportName} = ${JSON.stringify(html)};\n`,
    "utf-8",
  );

  console.log(`build-widget: wrote ${widget.outFile} (${(html.length / 1024).toFixed(0)} KB HTML · ${(css.length / 1024).toFixed(1)} KB CSS)`);
}
