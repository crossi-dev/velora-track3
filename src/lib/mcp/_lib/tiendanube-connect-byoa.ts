// src/lib/mcp/_lib/tiendanube-connect-byoa.ts — connect_tiendanube BYOA handler.
//
// Extracted from onboarding-tools.ts to keep that file within the 300-line limit.
// BYOA OAuth-redirect model (MCP 2025-11-25 third-party authorization standard).
//
// Primary flow: getTiendanubeConfig → createOAuthState → buildTiendanubeAuthorizationUrl
//   → return { ok, action: "authorize", authorizationUrl, instructions }
//
// Credential is NEVER returned to the caller — the OAuth callback stores it
// server-side as a BusinessChannelCredential (provider "tiendanube"):
//   encryptedCredentials = encryptCredential(JSON.stringify({ accessToken, storeId }))
//
// Reuses:
//   getTiendanubeConfig             — tiendanube/_lib/config.ts
//   buildTiendanubeAuthorizationUrl — tiendanube/_lib/config.ts
//   createOAuthState                — mp/_lib/oauth-state.ts (provider-agnostic)
//   errResponse                     — mcp-responses.ts (canonical)
//
// Source: tiendanube.github.io/api-documentation/authentication

import {
  getTiendanubeConfig,
  buildTiendanubeAuthorizationUrl,
} from "@/app/api/integrations/tiendanube/_lib/config";
import { createOAuthState } from "@/app/api/integrations/mp/_lib/oauth-state";
import { errResponse } from "./mcp-responses";

type McpToolContent = { type: "text"; text: string };
type McpToolResult = { content: McpToolContent[] } | ReturnType<typeof errResponse>;

/**
 * Handles the connect_tiendanube MCP tool.
 * businessId comes from the MCP server closure — never from tool input.
 */
export async function connectTiendanubeByoaHandler(
  businessId: string,
): Promise<McpToolResult> {
  const cfg = getTiendanubeConfig();
  if (!cfg.isConfigured) {
    return errResponse(
      "TN_NOT_CONFIGURED",
      "Tienda Nube OAuth no está configurado todavía. " +
      "El administrador de Velora necesita configurar TIENDANUBE_CLIENT_ID y TIENDANUBE_CLIENT_SECRET.",
    );
  }

  try {
    const state = await createOAuthState(businessId);
    // app_id = client_id per TN docs ("apps/{app_id}/authorize")
    const authorizationUrl = buildTiendanubeAuthorizationUrl(cfg.clientId, state);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          ok: true,
          action: "authorize",
          authorizationUrl,
          instructions:
            "Abrí este link para conectar tu tienda de Tienda Nube de forma segura. " +
            "Vas a autorizar en el sitio oficial de Tienda Nube; " +
            "Velora nunca ve tu token.",
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
