// src/lib/mcp/_lib/mp-connect-onboarding.ts — MercadoPago MCP onboarding handler.
//
// Extracted from onboarding-tools.ts (size-limit split) to keep that file under 300 LOC.
// Implements the two-path connect_mercadopago tool handler:
//   Primary (recommended): OAuth-redirect — builds auth.mercadopago.com.ar URL.
//   Fallback (demo/self-managed): APP_USR- token supplied directly.
//
// References:
//   MCP 2025-11-25 third-party auth: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
//   MP OAuth: developers.mercadopago.com.ar

import { buildMpAuthorizationUrl, getMpConfig } from "@/app/api/integrations/mp/_lib/config";
import { createOAuthState } from "@/app/api/integrations/mp/_lib/oauth-state";
import { connectMercadoPago } from "@/app/api/integrations/mp/connect-token/_lib/mp-connect-core";
import { errResponse } from "./mcp-responses";
import { MCP_ACTOR_USER_ID } from "./catalog-mutations";

/**
 * Handles the connect_mercadopago tool call.
 * Primary path: no accessToken → builds OAuth URL → owner authorizes on MP site.
 * Fallback path: APP_USR- token → validate + encrypt + store directly.
 */
export async function connectMercadoPagoHandler(
  businessId: string,
  accessToken: string | undefined,
) {
  // ── Token fallback path (optional APP_USR- token supplied) ──────────────
  if (accessToken !== undefined) {
    const result = await connectMercadoPago({
      businessId,
      actorUserId: MCP_ACTOR_USER_ID,
      accessToken,
    });
    if (!result.ok) return errResponse(result.code, result.message);
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, mpUserId: result.mpUserId }) }],
    };
  }

  // ── Primary OAuth-redirect path ──────────────────────────────────────────
  // MCP 2025-11-25 third-party authorization: return the authorization URL
  // so the owner authorizes on the official MercadoPago site. Velora's
  // /api/integrations/mp/callback completes the exchange server-side.
  const cfg = getMpConfig();
  if (!cfg.isConfigured) {
    return errResponse(
      "MP_NOT_CONFIGURED",
      "MercadoPago OAuth no está configurado todavía. " +
      "El administrador de Velora necesita configurar MP_CLIENT_ID, MP_CLIENT_SECRET y MP_REDIRECT_URI.",
    );
  }

  try {
    const state = await createOAuthState(businessId);
    const authorizationUrl = buildMpAuthorizationUrl({
      clientId: cfg.clientId,
      redirectUri: cfg.redirectUri,
      state,
    });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ok: true,
          action: "authorize",
          authorizationUrl,
          instructions:
            "Abrí este link para conectar tu cuenta de MercadoPago de forma segura. " +
            "Vas a autorizar en el sitio oficial de MercadoPago; " +
            "Velora nunca ve tu contraseña ni tu token.",
        }),
      }],
    };
  } catch {
    return errResponse(
      "UPSERT_FAILED",
      "No se pudo generar el link de autorización. Reintentá en unos segundos.",
    );
  }
}
