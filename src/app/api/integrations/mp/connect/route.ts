// GET /api/integrations/mp/connect — owner-only.
//
// Si MP no está configurado (env vars vacías) devuelve 503 con código
// MP_NOT_CONFIGURED para que la UI muestre "Pendiente de configuración".
// Si está configurado: genera un OAuthState (TTL 30 min) y:
//   • ?format=json → devuelve { authorizationUrl } como JSON (Capacitor + web)
//   • sin ?format  → redirige a la URL de autorización (compatibilidad legacy)
//
// El flujo recomendado para el cliente es ?format=json: el frontend llama
// este endpoint via fetch (que lleva el header x-velora-owner-token en
// Capacitor), recibe la URL y luego navega a ella. Así el paso autenticado
// viaja como XHR y el paso de navegación va a un dominio de MP sin requerir
// auth de Velora. El callback ya estaba allowlisted — no cambia.

import { NextRequest, NextResponse } from "next/server";
import {
  bypassIfTester,
  checkRateLimit,
  internalError,
  jsonError,
  logRouteError,
} from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import {
  buildMpAuthorizationUrl,
  getMpConfig,
} from "../_lib/config";
import { createOAuthState } from "../_lib/oauth-state";

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) {
    // Return 401 JSON — matches every other /integrations/*/connect route.
    // A 302 redirect causes Capacitor to follow it and return 200 HTML, which
    // is harder to detect as an error on the client side.
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  const cfg = getMpConfig();
  if (!cfg.isConfigured) {
    return jsonError(
      "MP_NOT_CONFIGURED",
      "Falta configurar credenciales Mercado Pago.",
      503,
    );
  }

  try {
    const state = await createOAuthState(ctx.businessId);

    // Mock mode bypass: instead of sending the owner to auth.mercadopago.com.ar,
    // point them at our callback with ?mock=1 so the callback creates a
    // synthetic MpConnection without touching MP. The OAuthState is still
    // consumed there for symmetry + idempotency.
    const webAuthorizationUrl = cfg.mockMode
      ? `${cfg.redirectUri || `${req.nextUrl.origin}/api/integrations/mp/callback`}?mock=1&state=${encodeURIComponent(state)}`
      : buildMpAuthorizationUrl({
          clientId: cfg.clientId,
          redirectUri: cfg.redirectUri,
          state,
        });

    // Mobile deep-link: if the request is from Android Chrome, wrap the URL
    // in an Android intent so Chrome opens the Mercado Pago native app when
    // installed (com.mercadopago.wallet), with the web URL as fallback.
    // iOS Safari handles Universal Links automatically when the MP iOS app
    // is installed — no special URL shape required.
    const ua = req.headers.get("user-agent") ?? "";
    const isAndroidChrome = /Android/i.test(ua) && /Chrome/i.test(ua) && !/wv\)/i.test(ua);
    const isMockUrl = cfg.mockMode;

    const authorizationUrl = (isAndroidChrome && !isMockUrl)
      ? `intent://${webAuthorizationUrl.replace(/^https?:\/\//, "")}` +
        `#Intent;scheme=https;package=com.mercadopago.wallet;` +
        `S.browser_fallback_url=${encodeURIComponent(webAuthorizationUrl)};end`
      : webAuthorizationUrl;

    // ?format=json — cliente fetcha la URL autenticado (XHR lleva el token),
    // luego navega a ella. Requerido para Capacitor Android donde la navegación
    // directa no puede llevar el header x-velora-owner-token.
    if (req.nextUrl.searchParams.get("format") === "json") {
      return NextResponse.json({ authorizationUrl });
    }

    // Fallback legacy: redirect directo (funciona en web con NextAuth cookie).
    return NextResponse.redirect(authorizationUrl, 302);
  } catch (error) {
    logRouteError("integrations/mp/connect", error);
    return internalError("No se pudo iniciar la conexión con Mercado Pago.");
  }
}
