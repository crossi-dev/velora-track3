// GET /api/integrations/tiendanube/callback — OAuth callback from Tienda Nube.
//
// TN redirige acá con ?code=...&state=... tras autorizar. La autenticación
// NO se valida con la cookie del dueño (puede no llegar en redirects cross-site
// SameSite=Lax) — se valida con el OAuthState (consume-once, TTL 30 min).
//
// Flow:
//   1. Validar code+state en query string.
//   2. Consumir OAuthState → obtener businessId.
//   3. Intercambiar code → { accessToken, storeId } en el TN token endpoint.
//   4. Cifrar { accessToken, storeId } con encryptCredential (AES-256-GCM).
//   5. Upsert BusinessChannelCredential (provider "tiendanube") — shape exacta
//      que loadTiendanubeCredentials (tiendanube-ventas.client.ts) lee.
//   6. Redirect a /dashboard?tab=servicios&tn=connected.
//
// Credential shape stored (must match loadTiendanubeCredentials exactly):
//   provider: "tiendanube"
//   encryptedCredentials: encryptCredential(JSON.stringify({ accessToken, storeId }))
//
// Source: tiendanube.github.io/api-documentation/authentication

import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { encryptCredential } from "@/lib/credential-cipher";
import { getTiendanubeConfig } from "../_lib/config";
import { consumeOAuthState } from "@/app/api/integrations/mp/_lib/oauth-state";
import { exchangeTiendanubeCode } from "../_lib/token-exchange";

// Declare mutations so check-architectural-invariants (INV-3) can verify
// this route against the canonical mutation contract.
const MUTATION_ACTIONS = {
  GET: "channel_credential.upsert",
} as const;
void MUTATION_ACTIONS;

const SUCCESS_REDIRECT = "/dashboard?tab=servicios&tn=connected";

function failureRedirect(reason: string): string {
  return `/dashboard?tab=servicios&tn=error&reason=${reason}`;
}

export async function GET(req: NextRequest) {
  if (checkRateLimit(req, "tn-callback", 10, 60)) {
    return redirectToDashboard(req, failureRedirect("rate_limited"));
  }

  const cfg = getTiendanubeConfig();
  if (!cfg.isConfigured) {
    return redirectToDashboard(req, failureRedirect("not_configured"));
  }

  const code = req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";

  if (!code) {
    return redirectToDashboard(req, failureRedirect("missing_code"));
  }
  if (!state) {
    return redirectToDashboard(req, failureRedirect("invalid_state"));
  }

  const consumed = await consumeOAuthState(state);
  if (!consumed) {
    return redirectToDashboard(req, failureRedirect("invalid_state"));
  }

  try {
    const result = await exchangeTiendanubeCode({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
    });

    if (!result.ok) {
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "TN_TOKEN_EXCHANGE_FAILED",
        a2a_transfer: false,
        message: `TN token exchange failed: status=${result.status} error=${result.error}`,
        businessId: consumed.businessId,
        data: { tnStatus: result.status, tnError: result.error },
      });
      return redirectToDashboard(req, failureRedirect("token_exchange_failed"));
    }

    // Encrypt and store in EXACTLY the shape loadTiendanubeCredentials reads:
    //   JSON.stringify({ accessToken, storeId }) — both string fields required.
    const plaintext = JSON.stringify({
      accessToken: result.accessToken,
      storeId: result.storeId,
    });
    const encryptedCredentials = encryptCredential(plaintext);

    await prisma.businessChannelCredential.upsert({
      where: { businessId_provider: { businessId: consumed.businessId, provider: "tiendanube" } },
      create: {
        businessId: consumed.businessId,
        provider: "tiendanube",
        encryptedCredentials,
        environment: "production",
      },
      update: { encryptedCredentials, environment: "production" },
    });

    return redirectToDashboard(req, SUCCESS_REDIRECT);
  } catch (error) {
    logRouteError("integrations/tiendanube/callback", error);
    return redirectToDashboard(req, failureRedirect("callback_exception"));
  }
}

function redirectToDashboard(req: NextRequest, target: string): NextResponse {
  // Cloud Run rewrites req.url to the internal bind URL (http://0.0.0.0:8080).
  // VELORA_APP_URL holds the public origin; dev fallback uses req.url.
  // Mirrors mp/callback/route.ts redirectToDashboard for consistency.
  const base = process.env.VELORA_APP_URL || new URL(req.url).origin;
  return NextResponse.redirect(new URL(target, base), 302);
}
