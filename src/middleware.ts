import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/auth.config";
import { OWNER_NATIVE_REFRESH_HEADER } from "@/lib/owner-native-auth-edge";
import { checkOwnerNativeSession } from "@/lib/middleware-session";
import { getClientIp } from "@/lib/client-ip";

const { auth } = NextAuth(authConfig);

// Each entry is an exact segment prefix: matches "/api/auth" and "/api/auth/..."
// but NOT "/api/authenticated" or any other path that merely shares the string.
//
// /api/scheduled is allowlisted because Cloud Scheduler hits these routes
// without a user session — auth is enforced inside each handler via
// verifyCronSecret() (Authorization: Bearer <CRON_SECRET>). Without the
// allowlist entry, middleware was rejecting every Scheduler tick at the
// session check and the bearer was never seen.
// /api/integrations/mp/callback es allowlist a nivel middleware porque el
// browser del dueño llega con cookie NextAuth válida en el caso normal,
// PERO el redirect viene de auth.mercadopago.com.ar (cross-site) y los
// browsers actuales pueden capar la cookie SameSite. La validación real
// se hace en el handler vía OAuthState (consume-once) — no via cookie.
// /api/agents/payments/jsonrpc is allowlisted because the Supervisor makes
// server-to-server A2A calls with no session cookie and no Origin header.
// Without this entry, isCsrfBlocked() returns 403 before the handler runs.
// Auth is enforced inside the route via verifyA2AApiKey + verifyAgentAssertion.
// /api/peers/*/agent-card and /api/peers/*/jwks are allowlisted per A2A v0.3.0
// spec: agent-card and JWKS endpoints must be publicly accessible for peer
// discovery.
// Agent and peer jsonrpc/agent-card/jwks paths are allowlisted because all
// inter-agent A2A calls are server-to-server (no browser Origin header) and
// isCsrfBlocked() would 403 them before the route handler runs. Each jsonrpc
// route enforces its own auth: verifyA2AApiKeyForTenant + verifyAgentAssertion.
// API_ALLOWLIST is an EXPLICIT list — when a new agent is added, its jsonrpc,
// agent-card and jwks paths MUST be appended here individually. They are NOT
// covered by a prefix pattern.
const API_ALLOWLIST = ["/api/auth", "/api/service-worker", "/api/whatsapp/webhook", "/api/health", "/api/a2a/agent-card", "/api/a2a/pubsub-handler", "/api/a2a/dead-letter", "/api/a2a/jsonrpc", "/api/public", "/api/cron", "/api/scheduled", "/api/business/public", "/api/integrations/mp/callback", "/api/integrations/mp/webhook", "/api/integrations/tiendanube/callback", "/api/integrations/modo/webhook", "/api/agents/andreani/webhook", "/api/agents/payments/jsonrpc", "/api/agents/fiscal/jsonrpc", "/api/agents/supervisor/agent-card", "/api/agents/supervisor/jsonrpc", "/api/agents/supervisor/jwks", "/api/agents/companion/agent-card", "/api/agents/companion/jsonrpc", "/api/agents/companion/jwks", "/api/agents/payments/agent-card", "/api/agents/payments/jwks", "/api/agents/fiscal/agent-card", "/api/agents/fiscal/jwks", "/api/agents/logistica/jsonrpc", "/api/agents/logistica/agent-card", "/api/agents/logistica/jwks", "/api/agents/ventas/jsonrpc", "/api/agents/ventas/agent-card", "/api/agents/ventas/jwks", "/api/agents/equipo/jsonrpc", "/api/agents/equipo/agent-card", "/api/agents/equipo/jwks", "/api/agents/communications/jsonrpc", "/api/agents/communications/agent-card", "/api/agents/communications/jwks", "/api/agents/onboarding/jsonrpc", "/api/agents/onboarding/agent-card", "/api/agents/onboarding/jwks", "/api/peers/distribuidora-mendoza/jsonrpc", "/api/peers/distribuidora-mendoza/agent-card", "/api/peers/distribuidora-mendoza/jwks", "/api/integrations/twilio/status", "/api/internal/tasks", "/api/internal/dlq",
// /api/integrations/tiendanube/callback: TN OAuth callback — cross-site redirect may drop SameSite cookie; validated inside handler via OAuthState (same pattern as mp/callback).
// /api/internal/agents/biz-snapshot: agent-to-core callback for payments biz prefetch —
// server-to-server, no browser session; auth enforced inside the handler via CRON_SECRET bearer.
// /api/internal/agents/shipments: agent-to-core callback for Andreani shipment writeback (Phase 2 S4) —
// server-to-server, no browser session; auth enforced inside the handler via CRON_SECRET bearer.
// /api/internal/agents/invoice-cae: agent-to-core callback for Fiscal CAE writeback (Phase 2 S5) —
// server-to-server, no browser session; auth enforced inside the handler via CRON_SECRET bearer.
// /api/internal/agents/payment-link-sale: agent-to-core callback for Payments sale registration (Phase 2 Payments) —
// server-to-server, no browser session; auth enforced inside the handler via CRON_SECRET bearer.
// Future internal-agents endpoints MUST be added here individually (explicit list, not a prefix wildcard).
"/api/internal/agents/biz-snapshot", "/api/internal/agents/shipments", "/api/internal/agents/invoice-cae", "/api/internal/agents/payment-link-sale", "/api/agents/customer/jsonrpc", "/api/agents/customer/agent-card", "/api/agents/customer/jwks", "/api/agents/caja/jsonrpc", "/api/agents/caja/agent-card", "/api/agents/caja/jwks", "/api/agents/inventario/jsonrpc", "/api/agents/inventario/agent-card", "/api/agents/inventario/jwks",
// /api/mcp: fiscal MCP server — dual-auth gated (HMAC or OAuth 2.1 Bearer)
"/api/mcp",
// /.well-known/oauth-protected-resource: RFC 9728 protected resource metadata.
// Public discovery endpoint — NO auth. MCP clients fetch this to find the AS.
// Must be allowlisted at middleware so NextAuth doesn't redirect unauthenticated
// discovery requests to the login page.
"/.well-known/oauth-protected-resource"];

const MUTATION_METHODS = new Set(["POST", "PATCH", "PUT", "DELETE"]);

// ---------------------------------------------------------------------------
// Inline rate limiter for /api/auth/* paths only.
//
// Why in-memory / per-instance: middleware runs on Edge Runtime which has no
// access to the Prisma client or Postgres DB. The DB-backed token bucket in
// route-helpers.ts#checkRateLimit is therefore unreachable here.
//
// Why it must live in middleware: NextAuth routes are handled by the
// [...nextauth] catch-all. There is no route.ts wrapper we can add
// checkRateLimit() to — middleware is the only intercept point before NextAuth
// core sees the request.
//
// Accepted trade-off: this limiter is coarse (per Cloud Run instance, not
// globally coordinated). It acts as a layered-defense backstop alongside
// Cloud Armor and NextAuth's own PIN lockout. All other /api routes —
// including the AI routes — get DB-backed, multi-instance-safe limiting via
// the route-handler checkRateLimit("ai", 30, 60) call in each handler.
// ---------------------------------------------------------------------------
const AUTH_RATE_LIMIT_MAX = 60; // 60 attempts / minute / IP (raised from 10: OAuth sign-in = ~5 redirects; 10 concurrent users = 50 hits/min)
const AUTH_RATE_LIMIT_WINDOW_MS = 60_000;
const AUTH_RATE_LIMIT_MAX_KEYS = 5_000;
const authRateLimitMap = new Map<string, number[]>();

function makeRateLimiter(map: Map<string, number[]>, max: number, windowMs: number, maxKeys = AUTH_RATE_LIMIT_MAX_KEYS) {
  return function check(key: string): boolean {
    const now = Date.now();
    const cutoff = now - windowMs;
    if (map.size > maxKeys) {
      for (const [k, ts] of map) {
        if (ts.length === 0 || (ts[ts.length - 1] ?? 0) <= cutoff) map.delete(k);
      }
    }
    const recent = (map.get(key) ?? []).filter((t) => t > cutoff);
    recent.push(now);
    map.set(key, recent);
    return recent.length <= max;
  };
}

const checkAuthRateLimit = makeRateLimiter(authRateLimitMap, AUTH_RATE_LIMIT_MAX, AUTH_RATE_LIMIT_WINDOW_MS);

function isAllowlisted(pathname: string): boolean {
  return API_ALLOWLIST.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + "/")
  );
}

function isCsrfBlocked(req: Parameters<Parameters<typeof auth>[0]>[0]): boolean {
  if (!MUTATION_METHODS.has(req.method)) return false;
  const { pathname, origin: appOrigin } = req.nextUrl;
  if (!pathname.startsWith("/api/") || isAllowlisted(pathname)) return false;

  const originHeader = req.headers.get("origin");
  const refererHeader = req.headers.get("referer");
  // Guard: new URL() throws on malformed Referer (relative paths, data: URIs, etc.)
  // which would crash the Edge middleware with a 500 before any response is sent.
  let refererOrigin: string | null = null;
  if (refererHeader) {
    try {
      refererOrigin = new URL(refererHeader).origin;
    } catch {
      refererOrigin = null;
    }
  }
  const candidate = originHeader ?? refererOrigin;
  // Si ambos headers están ausentes, rechazar: los browsers legítimos siempre
  // incluyen al menos uno. El WebView de Capacitor también envía Origin.
  // Permitir requests sin origen es el vector clásico de CSRF silencioso.
  if (candidate === null) return true;
  // Allow Cloud Run internal URL, public domain, www variant (LB serves both),
  // and Capacitor schemes used by the Android/iOS WebView.
  const publicOrigin = (process.env.NEXTAUTH_URL ?? "").replace(/\/$/, "");
  const wwwOrigin = publicOrigin.replace(/^(https?:\/\/)/, "$1www.");
  // Capacitor WebView origins: capacitor://localhost (Capacitor 3+),
  // https://localhost and http://localhost (Capacitor legacy / iOS simulator).
  const CAPACITOR_ORIGINS = new Set([
    "capacitor://localhost",
    "https://localhost",
    "http://localhost",
  ]);
  const allowed =
    candidate === appOrigin ||
    (publicOrigin !== "" && candidate === publicOrigin) ||
    (wwwOrigin !== publicOrigin && candidate === wwwOrigin) ||
    CAPACITOR_ORIGINS.has(candidate);
  if (!allowed) {
    // Log the real origin value so we can diagnose future mismatches.
    // Use console.log (stdout), not console.warn (stderr). Cloud Run only
    // auto-parses structured JSON from stdout — stderr lands as raw text
    // and the `action` field is not indexed (causes invisible logs).
    console.log(JSON.stringify({ severity: "WARNING", component: "System", action: "CSRF_REJECTED_ORIGIN", a2a_transfer: false, message: "CSRF check: rejected origin", rejectedOrigin: candidate, path: pathname, method: req.method }));
  }
  return !allowed;
}

export default auth(async (req) => {
  const host = req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;

  // tools.somosvelora.com root → serve the MCP toolkit landing page.
  // Rewrite ONLY bare "/" — all /api/* paths (including /api/mcp) pass through
  // untouched so the MCP endpoint keeps working. This runs before any auth logic.
  // Exact host match (not a prefix) so a spoofed `tools.*` Host can't trigger it.
  if (host === "tools.somosvelora.com" && pathname === "/") {
    return NextResponse.rewrite(new URL("/tools", req.url));
  }

  // Canonicalize www → apex BEFORE any other logic.
  // __Host- prefixed NextAuth cookies are scoped to exact host; www and apex
  // have separate cookie jars, which breaks PKCE (callback lands on apex but
  // verifier cookie was set on www). 308 preserves method (POST safe for
  // /api/auth/callback/google).
  if (host.startsWith("www.") && host.slice(4) === "somosvelora.com") {
    const target = new URL(
      req.nextUrl.pathname + req.nextUrl.search,
      "https://somosvelora.com"
    );
    return NextResponse.redirect(target, 308);
  }

  const isLoggedIn = !!req.auth;

  // Auth rate limiter is ALWAYS active in production (NODE_ENV=production),
  // regardless of RATE_LIMIT_ENABLED. In non-production it respects
  // RATE_LIMIT_AUTH_ENABLED (off only if explicitly set to "false").
  // NOTE: do NOT import from rate-limit-core.ts — that module loads Prisma
  // which is not Edge-compatible. The logic is inlined here intentionally.
  const authRateLimitActive =
    process.env.NODE_ENV === "production" ||
    process.env.RATE_LIMIT_AUTH_ENABLED !== "false";

  if (pathname.startsWith("/api/")) {
    // Rate limit /api/auth/* BEFORE allowlist bypass so NextAuth handlers are protected.
    // Credential stuffing / OAuth callback flooding is the main threat here.
    if (authRateLimitActive && (pathname === "/api/auth" || pathname.startsWith("/api/auth/"))) {
      const ip = getClientIp(req.headers);
      if (!checkAuthRateLimit(ip)) {
        // cloudLog is not used here: middleware runs on Edge Runtime which does not share
        // the Node.js AsyncLocalStorage context that cloudLog relies on for trace propagation.
        // Use console.log (stdout) — Cloud Run only auto-parses structured JSON from stdout;
        // console.warn goes to stderr and is NOT indexed as structured fields (action stays empty).
        console.log(JSON.stringify({ severity: "WARNING", component: "System", action: "AUTH_RATE_LIMIT", a2a_transfer: false, message: "Auth rate limit exceeded", path: pathname, ip }));
        return Response.json(
          { error: "Demasiadas solicitudes. Intentá de nuevo en un minuto." },
          { status: 429, headers: { "Retry-After": "60" } }
        );
      }
    }
    // SHORT-CIRCUIT: allowlisted paths (Cloud Scheduler, A2A, webhooks, etc.) skip all
    // session checks. Expensive HMAC crypto runs only for paths that need auth.
    if (isAllowlisted(pathname)) {
      return;
    }
    if (isCsrfBlocked(req)) {
      console.log(JSON.stringify({ severity: "WARNING", component: "System", action: "CSRF_BLOCKED", a2a_transfer: false, message: "CSRF check failed — origin mismatch", path: pathname, method: req.method }));
      return Response.json({ error: "Forbidden." }, { status: 403 });
    }
    // Run expensive HMAC session checks only for non-allowlisted API paths.
    const ownerNativeCheck = await checkOwnerNativeSession(req);
    const isOwnerNative = ownerNativeCheck.isOwnerNative;
    // Acceso aceptable si OAuth (owner) o token nativo owner.
    // El detalle de quién es el actor y qué permisos tiene se resuelve en cada
    // route via resolveActor() — middleware solo gatekeepea la presencia.
    if (!isLoggedIn && !isOwnerNative) {
      console.log(JSON.stringify({ severity: "WARNING", component: "System", action: "UNAUTHENTICATED_ACCESS", a2a_transfer: false, message: "API access without valid session", path: pathname, method: req.method }));
      // Browser top-level navigations (e.g. owner clicking "Conectar MP") send
      // Sec-Fetch-Mode: navigate. Redirect to login so the user doesn't see raw
      // JSON. XHR/fetch calls do NOT send this header — those keep the 401 so
      // fetchWithTimeout's interceptor can do its own graceful redirect.
      const isBrowserNav = req.headers.get("sec-fetch-mode") === "navigate";
      if (isBrowserNav) {
        const callbackUrl = encodeURIComponent(pathname + req.nextUrl.search);
        return NextResponse.redirect(new URL(`/?callbackUrl=${callbackUrl}`, req.url));
      }
      return Response.json({ error: "No autorizado." }, { status: 401 });
    }
    // Owner native token refresh: piggyback a new token on any authenticated response.
    if (ownerNativeCheck.shouldRefresh && ownerNativeCheck.refreshedToken) {
      const response = NextResponse.next();
      response.headers.set(OWNER_NATIVE_REFRESH_HEADER, ownerNativeCheck.refreshedToken);
      return response;
    }
    return;
  }

  // Páginas: /dashboard requiere ser owner OAuth o token nativo owner.
  // Run HMAC checks only for protected page paths.
  if (pathname.startsWith("/dashboard") || pathname.startsWith("/onboarding")) {
    const ownerNativeCheck = await checkOwnerNativeSession(req);
    const isOwnerNative = ownerNativeCheck.isOwnerNative;
    if (!isLoggedIn && !isOwnerNative) {
      return Response.redirect(new URL("/", req.url));
    }
  }
});

export const config = {
  // "/" is included so the tools.somosvelora.com host rewrite fires on the bare root.
  // All other entries are unchanged.
  matcher: ["/", "/dashboard/:path*", "/onboarding/:path*", "/api/:path*"],
};
