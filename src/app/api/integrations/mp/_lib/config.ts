// Configuración OAuth Mercado Pago — slice 7 del módulo Cobro QR.
//
// Hoy el dueño todavía no registró su app MP developer (lo hace después).
// Mientras tanto las env vars MP_CLIENT_ID/SECRET/REDIRECT_URI quedan vacías
// y la UI muestra "Pendiente de configuración" en vez de crashear. Cuando
// las complete via Cloud Run env vars, el flow OAuth se habilita sin deploy.
//
// `isConfigured` es la única gate que las routes consultan antes de pegarle
// a la API de MP — si es false, /connect devuelve 503 y /status reporta
// `configured: false`. Defensive design: nunca asumimos credenciales.

import { isDemoBusiness } from "@/lib/demo-business";

export interface MpConfig {
  isConfigured: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /**
   * When MP_MOCK_MODE=true the connect flow skips the real MP OAuth and
   * provisions a synthetic MpConnection. Used for the demo path when real MP
   * credentials are not available or the developer app isn't approved yet.
   * Logged at startup if active in production.
   */
  mockMode: boolean;
}

export function getMpConfig(): MpConfig {
  const clientId = (process.env.MP_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.MP_CLIENT_SECRET ?? "").trim();
  const redirectUri = (process.env.MP_REDIRECT_URI ?? "").trim();
  const mockMode = process.env.MP_MOCK_MODE === "true";
  // isConfigured stays true in mock mode even without real credentials — the
  // mock path doesn't need them. This lets the connect route render the OAuth
  // button (which actually triggers the mock bypass).
  const isConfigured =
    mockMode || (clientId.length > 0 && clientSecret.length > 0 && redirectUri.length > 0);
  return { isConfigured, clientId, clientSecret, redirectUri, mockMode };
}

/**
 * Non-throwing variant of isMockEnabled for tool-visibility gating decisions.
 *
 * Mirrors isAndreaniMockActive() in andreani-mock.ts. MP_MOCK_MODE=true exposes
 * payment tools even without a real MpConnection row so the agent can call the
 * mock path and return synthetic data (fixing CapabilityToolset vs *_MOCK_MODE
 * mismatch documented in CLAUDE.md Known Gaps).
 *
 * Production safety: requires MP_ALLOW_MOCK_IN_PROD=true as an explicit escape
 * hatch (same model as Andreani). Returns false in prod without the opt-in so
 * a misconfigured env never exposes mock payment tools to real customers.
 *
 * Per-business gate: when businessId is provided, mock is only active for demo
 * businesses (DEMO_BUSINESS_IDS env var). Real businesses always get real mode
 * even when the global MP_MOCK_MODE flag is on.
 */
export function isMpMockActive(businessId?: string): boolean {
  if ((process.env.MP_MOCK_MODE ?? "").toLowerCase() !== "true") return false;
  if (process.env.NODE_ENV === "production") {
    if ((process.env.MP_ALLOW_MOCK_IN_PROD ?? "").toLowerCase() !== "true") return false;
  }
  // Per-business gate: if a businessId is supplied, only demo businesses get mock mode.
  // Callers that cannot supply a businessId fall through to global flag behavior.
  if (businessId !== undefined && !isDemoBusiness(businessId)) return false;
  return true;
}

// URL de autorización del usuario final. Argentina: auth.mercadopago.com.ar.
// `state` es el token único que persiste en OAuthState para validar el callback.
export function buildMpAuthorizationUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    response_type: "code",
    platform_id: "mp",
    state: args.state,
    redirect_uri: args.redirectUri,
  });
  return `https://auth.mercadopago.com.ar/authorization?${params.toString()}`;
}

// Endpoint canónico para token exchange + refresh.
export const MP_TOKEN_ENDPOINT = "https://api.mercadopago.com/oauth/token";

// Respuesta del token endpoint (authorization_code y refresh_token comparten shape).
//
// MP 2026: para ciertos scopes (in-store + admin) el OAuth devuelve un token
// long-lived (expires_in: 15552000 = 180 días) SIN refresh_token. El owner
// re-autoriza cuando expira. Para scopes legacy todavía manda refresh_token.
// Por eso `refresh_token` es opcional.
export interface MpTokenResponse {
  access_token: string;
  public_key?: string;
  refresh_token?: string;
  live_mode?: boolean;
  user_id: number | string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

// Type guard relajado — MP a veces devuelve user_id como number, a veces
// como string. Toleramos ambos y normalizamos en el caller. refresh_token
// es opcional (long-lived tokens no traen refresh).
export function isMpTokenResponse(value: unknown): value is MpTokenResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.access_token === "string" &&
    typeof v.expires_in === "number" &&
    (typeof v.user_id === "number" || typeof v.user_id === "string") &&
    (v.refresh_token === undefined || typeof v.refresh_token === "string")
  );
}
