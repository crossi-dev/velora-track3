import type { NextConfig } from "next";

// CSP script-src:
// - dev: needs 'unsafe-inline' + 'unsafe-eval' (HMR + React Refresh)
// - prod: 'unsafe-inline' sigue siendo necesario porque Next.js inyecta scripts
//   inline de bootstrap (hydration, __NEXT_DATA__) sin nonce por defecto. Una
//   migración a nonce-based CSP requiere middleware + headers() en layout +
//   <Script nonce={...}>. Ver docs/security-notes.md §CSP.
const cspScriptSrc =
  process.env.NODE_ENV === "development"
    ? "'self' 'unsafe-inline' 'unsafe-eval'"
    : "'self' 'unsafe-inline'";

// CSP connect-src:
// - 'self': same-origin API calls (web browser).
// - capacitor://localhost https://localhost: Capacitor Android WebView issues
//   fetch() against the app shell using these schemes. Without them the WebView
//   cannot reach any API route and the app silently breaks. These are controlled
//   origins (the WebView loads Velora's own bundle), not external third parties.
// - ws://localhost wss://localhost: Next.js HMR websocket in development only.
const cspConnectSrc =
  process.env.NODE_ENV === "development"
    ? "'self' capacitor://localhost https://localhost ws://localhost wss://localhost"
    : "'self' capacitor://localhost https://localhost";

const nextConfig: NextConfig = {
  output: "standalone",
  // Tree-shake barrel imports: @phosphor-icons/react re-exports ~1.5k icons from a
  // single entry, so a `import { Foo } from "@phosphor-icons/react"` pulls the whole
  // barrel into the dev bundle and slows first compile + ships dead code. This is the
  // SAME transform Next.js applies by default to lucide-react / @heroicons / @mui /
  // @tabler (see its default-optimized list) — Phosphor just isn't in that list, so we
  // opt it in explicitly. The "experimental" label is on the config namespace, not the
  // transform's safety (the default libs above are optimized in production via it).
  // Source: https://nextjs.org/docs/app/api-reference/config/next-config-js/optimizePackageImports (Next 16.2.6, 2026-05-28)
  experimental: {
    optimizePackageImports: ["@phosphor-icons/react"],
  },
  serverExternalPackages: ["pdfkit", "mammoth", "@google/adk", "@google-cloud/profiler", "@google-cloud/tasks"],
  outputFileTracingIncludes: {
    // @google-cloud/tasks loads JSON config files via dynamic require at runtime;
    // Next's file tracing misses non-JS assets under serverExternalPackages.
    // Five asset trees are required:
    //   - build/protos/**            — protobuf descriptors (previously known)
    //   - build/esm/src/v2/**       — cloud_tasks_client_config.json + proto_list.json
    //   - build/esm/src/v2beta2/**  — same files for v2beta2 client (index.js imports all 3)
    //   - build/esm/src/v2beta3/**  — same files for v2beta3 client (index.js imports all 3)
    //   - build/cjs/src/v2/**       — CJS equivalents (Node may pick either tree)
    //   - build/cjs/src/v2beta2/**
    //   - build/cjs/src/v2beta3/**
    // All loaded by json-helper.cjs via getJSON() at module init.
    // Missing in standalone = MODULE_NOT_FOUND 500 on every request.
    // Ref: https://github.com/googleapis/nodejs-tasks/issues/655
    // Ref: https://nextjs.org/docs/app/api-reference/config/next-config-js/outputFileTracingIncludes
    "/api/scheduled/mp-payment-reconcile": [
      "./node_modules/@google-cloud/tasks/build/protos/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2beta2/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2beta3/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2beta2/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2beta3/**",
    ],
    "/api/internal/tasks/confirm-payment": [
      "./node_modules/@google-cloud/tasks/build/protos/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2beta2/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2beta3/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2beta2/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2beta3/**",
    ],
    "/api/internal/tasks/cancel-payment": [
      "./node_modules/@google-cloud/tasks/build/protos/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2beta2/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2beta3/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2beta2/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2beta3/**",
    ],
    "/api/integrations/mp/webhook": [
      "./node_modules/@google-cloud/tasks/build/protos/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2beta2/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2beta3/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2beta2/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2beta3/**",
    ],
    "/api/whatsapp/webhook": [
      "./node_modules/@google-cloud/tasks/build/protos/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2beta2/**",
      "./node_modules/@google-cloud/tasks/build/esm/src/v2beta3/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2beta2/**",
      "./node_modules/@google-cloud/tasks/build/cjs/src/v2beta3/**",
    ],
  },
  env: {
    // Stamped once per build/dev-server start — drives SW cache versioning
    BUILD_TIME: new Date().toISOString(),
  },
  async rewrites() {
    return [
      // A2A protocol v0.3.0 — well-known agent card discovery paths.
      // External agents fetch these to learn Velora agent capabilities + auth schemes.
      {
        source: "/.well-known/agent-card.json",
        destination: "/api/a2a/agent-card",
      },
      {
        source: "/.well-known/payments-agent-card.json",
        destination: "/api/agents/payments/agent-card",
      },
      {
        source: "/.well-known/fiscal-agent-card.json",
        destination: "/api/agents/fiscal/agent-card",
      },
      {
        source: "/.well-known/mercadolibre-agent-card.json",
        destination: "/api/agents/mercadolibre/agent-card",
      },
      {
        source: "/.well-known/onboarding-agent-card.json",
        destination: "/api/agents/onboarding/agent-card",
      },
      // A2A directory — lists all Velora agents and their AgentCard URLs.
      {
        source: "/.well-known/agents.json",
        destination: "/api/well-known/agents",
      },
    ];
  },
  async headers() {
    return [
      // MCP endpoint — Link: rel="describedby" points AI clients to the llms.txt
      // that describes available tools and auth.
      // Source: https://llmstxt.org/#link-header (llmstxt.org spec, 2024)
      {
        source: "/api/mcp",
        headers: [
          {
            key: "Link",
            value: '<https://tools.somosvelora.com/llms.txt>; rel="describedby"',
          },
        ],
      },
      // Compatibility alias for hosted MCP clients configured with /mcp
      // instead of the canonical /api/mcp endpoint.
      {
        source: "/mcp",
        headers: [
          {
            key: "Link",
            value: '<https://tools.somosvelora.com/llms.txt>; rel="describedby"',
          },
        ],
      },
      // All API routes carry user/business data — never cache at CDN or shared proxy.
      // Routes that are intentionally cacheable (agent-card, vapid-key) override
      // this per-route with their own Cache-Control header, which takes precedence
      // because route handlers run after Next.js injects these config headers.
      {
        source: "/api/(.*)",
        headers: [
          { key: "Cache-Control", value: "no-store" },
        ],
      },
      // OG image route: relaxed img-src so WhatsApp's link-preview crawler can fetch
      // the 1200×630 PNG. The global CSP restricts img-src to 'self data: blob:',
      // which blocks external crawlers (WhatsApp, Telegram, Slack) from loading the
      // image — rich link previews degrade to text-only. We scope the relaxation to
      // the exact opengraph-image path so the rest of the app keeps the stricter policy.
      // Next.js App Router per-path header override: more-specific source wins.
      // Ref: https://nextjs.org/docs/app/api-reference/config/next-config-js/headers (2026)
      // Note: 'self' already covers same-origin; adding data: and blob: is belt-and-suspenders
      // so the image renderer can inline small assets if needed.
      {
        source: "/pay/:paymentIntentId/opengraph-image",
        headers: [
          {
            key: "Content-Security-Policy",
            value: `default-src 'self'; script-src ${cspScriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' https://fonts.gstatic.com; connect-src ${cspConnectSrc}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests;`,
          },
        ],
      },
      {
        source: "/(.*)",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // camera=(self): Velora uses camera for photo attachments in the assistant
          // (T5 supervisor flow, AssistantAttachMenu). Restricting to () would silently
          // block that feature on browsers that enforce Permissions-Policy.
          // browsing-topics=(): replaces deprecated interest-cohort=() (FLoC successor).
          { key: "Permissions-Policy", value: "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), browsing-topics=()" },
          // DNS prefetch leaks navigation intent to resolvers — off for a financial app.
          { key: "X-DNS-Prefetch-Control", value: "off" },
          {
            key: "Content-Security-Policy",
            // unsafe-inline es necesario: Next.js inyecta scripts inline y styled-jsx usa estilos inline.
            // unsafe-eval solo se incluye en desarrollo (HMR). En producción no es necesario.
            // connect-src includes capacitor://localhost so the Capacitor Android WebView
            // can reach all API routes without CSP violations.
            value: `default-src 'self'; script-src ${cspScriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' https://fonts.gstatic.com; connect-src ${cspConnectSrc}; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests;`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
