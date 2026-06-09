// GET /api/integrations/tiendanube/connect — owner-only.
//
// Espejo de mp/connect/route.ts. Genera un OAuthState (TTL 30 min, consume-once,
// businessId-bound) y devuelve { authorizationUrl }. El redirect_uri NO va en
// la URL — está configurado en el dashboard de la app TN de Velora.
//
// ?format=json → { authorizationUrl } (requerido para Capacitor / XHR)
// sin ?format   → 302 redirect a la URL de autorización (fallback legacy)
//
// La autenticación del dueño viaja como XHR (lleva header x-velora-owner-token
// en Capacitor); la navegación posterior va al dominio de TN sin auth de Velora.
//
// Source: tiendanube.github.io/api-documentation/authentication

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
  buildTiendanubeAuthorizationUrl,
  getTiendanubeConfig,
} from "../_lib/config";
import { createOAuthState } from "@/app/api/integrations/mp/_lib/oauth-state";

export async function GET(req: NextRequest) {
  const ctx = await resolveActor(req);
  if (!ctx) {
    return jsonError("UNAUTHORIZED", "Authentication required.", 401);
  }

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(ctx));
  if (rateLimited) return rateLimited;
  const roleGate = requireRole(ctx, ["owner"]);
  if (roleGate) return roleGate;

  const cfg = getTiendanubeConfig();
  if (!cfg.isConfigured) {
    return jsonError(
      "TN_NOT_CONFIGURED",
      "Falta configurar credenciales Tienda Nube.",
      503,
    );
  }

  try {
    // OAuthState is provider-agnostic — reused from the MP module.
    const state = await createOAuthState(ctx.businessId);

    // app_id = client_id per TN docs ("Authorization URL: .../apps/{app_id}/authorize")
    const authorizationUrl = buildTiendanubeAuthorizationUrl(cfg.clientId, state);

    if (req.nextUrl.searchParams.get("format") === "json") {
      return NextResponse.json({ authorizationUrl });
    }

    return NextResponse.redirect(authorizationUrl, 302);
  } catch (error) {
    logRouteError("integrations/tiendanube/connect", error);
    return internalError("No se pudo iniciar la conexión con Tienda Nube.");
  }
}
