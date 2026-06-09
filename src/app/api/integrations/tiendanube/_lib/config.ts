// Configuración OAuth Tienda Nube (Nuvemshop) — espejo exacto del patrón mp/_lib/config.ts.
//
// `isConfigured` es la única gate que las routes consultan antes de proceder.
// Si es false, /connect devuelve 503 con TN_NOT_CONFIGURED.
// Las credenciales NUNCA pasan por el chat; el callback las recibe y las
// persiste cifradas en BusinessChannelCredential.
//
// Source (HTTP 200): tiendanube.github.io/api-documentation/authentication
//
//   Authorization URL : https://www.tiendanube.com/apps/{app_id}/authorize?state={state}
//   Token exchange    : POST https://www.tiendanube.com/apps/authorize/token
//                       { client_id, client_secret, grant_type, code }
//   Redirect URI      : configured in the TN app dashboard (NOT a query param)
//
// Env vars: TIENDANUBE_CLIENT_ID, TIENDANUBE_CLIENT_SECRET
// (Carlos registers Velora's TN app + sets callback URL in the TN app dashboard.)

export interface TiendanubeConfig {
  isConfigured: boolean;
  clientId: string;
  clientSecret: string;
}

export function getTiendanubeConfig(): TiendanubeConfig {
  const clientId = (process.env.TIENDANUBE_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.TIENDANUBE_CLIENT_SECRET ?? "").trim();
  const isConfigured = clientId.length > 0 && clientSecret.length > 0;
  return { isConfigured, clientId, clientSecret };
}

/**
 * Builds the Tienda Nube user authorization URL.
 *
 * Per official docs the redirect_uri is NOT included as a query parameter —
 * it is configured in the TN app dashboard. The only variable param is `state`
 * (CSRF token).
 *
 * Source: tiendanube.github.io/api-documentation/authentication
 *   "Authorization URL: https://www.tiendanube.com/apps/{app_id}/authorize?state={state}"
 */
export function buildTiendanubeAuthorizationUrl(appId: string, state: string): string {
  return `https://www.tiendanube.com/apps/${encodeURIComponent(appId)}/authorize?state=${encodeURIComponent(state)}`;
}

/** Token exchange endpoint per official docs. */
export const TN_TOKEN_ENDPOINT = "https://www.tiendanube.com/apps/authorize/token";
