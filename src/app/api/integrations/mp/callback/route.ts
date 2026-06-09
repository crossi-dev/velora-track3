// GET /api/integrations/mp/callback — endpoint de retorno del OAuth de MP.
//
// MP redirige acá con `?code=...&state=...`. La autenticación NO se valida
// con la cookie del dueño (puede no llegar en redirects cross-site SameSite=Lax)
// sino con el OAuthState (consume-once, TTL 30 min) que dejamos en /connect.
//
// Flow:
//   1. Validar code+state en query string.
//   2. Consumir OAuthState → obtener businessId.
//   3. Intercambiar code → tokens en MP token endpoint.
//   4. Upsert MpConnection.
//   5. Clear mercadoPagoOnboardingDeferred (set at T3 to guard against window close).
//   6. Redirect a /dashboard?tab=servicios&mp=connected.

import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, logRouteError } from "@/app/api/_lib/route-helpers";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { encrypt } from "@/infrastructure/crypto/mp-token-cipher";
import { getMpConfig } from "../_lib/config";
import { consumeOAuthState } from "../_lib/oauth-state";
import { exchangeAuthorizationCode } from "../_lib/token-exchange";
import { ensureMpStorePosProvisioned } from "../_lib/mp-pos-provisioning";
import { invalidateSupervisorContext } from "@/app/api/supervisor/_lib/load-context";

// Declare mutations so check-architectural-invariants (INV-3) can verify
// this route against the canonical mutation contract.
const MUTATION_ACTIONS = {
  GET: "mp_connection.connect_self_managed",
} as const;
void MUTATION_ACTIONS; // suppress unused-var warning — declaration is for static analysis only

const SUCCESS_REDIRECT = "/dashboard?tab=servicios&mp=connected";

function failureRedirect(reason: string) {
  return `/dashboard?tab=servicios&mp=error&reason=${reason}`;
}

export async function GET(req: NextRequest) {
  if (checkRateLimit(req, "mp-callback", 10, 60)) {
    return redirectToDashboard(req, failureRedirect("rate_limited"));
  }

  const cfg = getMpConfig();
  if (!cfg.isConfigured) {
    return redirectToDashboard(req, failureRedirect("not_configured"));
  }

  const code = req.nextUrl.searchParams.get("code") ?? "";
  const state = req.nextUrl.searchParams.get("state") ?? "";
  const isMockCallback = req.nextUrl.searchParams.get("mock") === "1";

  // Mock callback: skip code validation (no real OAuth happened) but still
  // consume the OAuthState for symmetry + replay protection.
  if (cfg.mockMode && isMockCallback) {
    if (!state) {
      return redirectToDashboard(req, failureRedirect("invalid_state"));
    }
    const consumed = await consumeOAuthState(state);
    if (!consumed) {
      return redirectToDashboard(req, failureRedirect("invalid_state"));
    }
    // Far-future expiry — mock connection never expires.
    const expiresAt = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
    const mockData = {
      mpUserId: `mock-${consumed.businessId.slice(0, 8)}`,
      accessTokenCiphertext: encrypt("MOCK-ACCESS-TOKEN-DEMO-ONLY"),
      refreshTokenCiphertext: encrypt("MOCK-REFRESH-TOKEN-DEMO-ONLY"),
      publicKey: null,
      liveMode: false,
      scope: "mock",
      expiresAt,
    };
    await prisma.mpConnection.upsert({
      where: { businessId: consumed.businessId },
      create: { businessId: consumed.businessId, ...mockData },
      update: mockData,
    });
    // Clear the onboarding deferred flag set at T3 when open_mp_oauth fired.
    // This lets detectPendingTurn advance past the payment step on the next chat
    // turn. Also invalidates the supervisor context cache (including inflight).
    await prisma.business.update({
      where: { id: consumed.businessId },
      data: { mercadoPagoOnboardingDeferred: false },
    });
    invalidateSupervisorContext(consumed.businessId);
    // Skip ensureMpStorePosProvisioned — that hits real MP API.
    return redirectToDashboard(req, `${SUCCESS_REDIRECT}&mock=1`);
  }

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
    const result = await exchangeAuthorizationCode({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
      redirectUri: cfg.redirectUri,
    });
    if (!result.ok) {
      // Surface why the exchange failed — without this log the callback dies
      // silently with ?mp=error and there's no way to diagnose from logs alone.
      cloudLog({
        severity: "ERROR",
        component: "System",
        action: "MP_TOKEN_EXCHANGE_FAILED",
        a2a_transfer: false,
        message: `MP token exchange failed: status=${result.status} error=${result.error}`,
        businessId: consumed.businessId,
        data: {
          mpStatus: result.status,
          mpError: result.error,
          redirectUri: cfg.redirectUri,
          clientIdPrefix: cfg.clientId.slice(0, 8),
        },
      });
      return redirectToDashboard(req, failureRedirect("token_exchange_failed"));
    }

    const tokens = result.tokens;
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
    const data = {
      mpUserId: String(tokens.user_id),
      accessTokenCiphertext: encrypt(tokens.access_token),
      // refresh_token missing for long-lived scopes (MP 2026 in-store/admin).
      // Column is nullable; owner re-authorizes when access_token expires.
      refreshTokenCiphertext: tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      publicKey: tokens.public_key ?? null,
      liveMode: tokens.live_mode ?? false,
      scope: tokens.scope ?? null,
      expiresAt,
    };
    await prisma.mpConnection.upsert({
      where: { businessId: consumed.businessId },
      create: { businessId: consumed.businessId, ...data },
      update: data,
    });

    // Clear the onboarding deferred flag set at T3 when open_mp_oauth fired.
    // detectPendingTurn will see mercadoPagoOnboardingDeferred=false AND
    // mercadoPagoConnected=true on the next chat turn, advancing past the
    // payment step. Without this the flag stays true and the flow re-prompts T3.
    // invalidateSupervisorContext also evicts any in-flight cache promise so
    // the next load call hits the DB (fix for singleflight stale-read race).
    await prisma.business.update({
      where: { id: consumed.businessId },
      data: { mercadoPagoOnboardingDeferred: false },
    });
    invalidateSupervisorContext(consumed.businessId);

    // Auto-provision MP store + POS for this business — best-effort.
    // If provisioning fails, externalPosId stays null and the QR path will
    // attempt lazy re-provisioning on first use. The OAuth flow itself MUST
    // NOT fail because of a provisioning error.
    // Fire-and-forget: provisioning failure is logged inside
    // ensureMpStorePosProvisioned. If it fails, externalPosId stays null and
    // the QR path will lazy-provision on first use.
    void ensureMpStorePosProvisioned({
      businessId: consumed.businessId,
      accessToken: tokens.access_token,
      mpUserId: String(tokens.user_id),
    });

    return redirectToDashboard(req, SUCCESS_REDIRECT);
  } catch (error) {
    logRouteError("integrations/mp/callback", error);
    return redirectToDashboard(req, failureRedirect("callback_exception"));
  }
}

function redirectToDashboard(req: NextRequest, target: string): NextResponse {
  // In Cloud Run, req.url is the INTERNAL bind URL (http://0.0.0.0:8080),
  // not the public origin. Using it as the base produces redirects to
  // 0.0.0.0:8080 which the user's browser can't reach. VELORA_APP_URL is
  // the public origin (set in Cloud Run env vars). Dev fallback uses req.url.
  const base = process.env.VELORA_APP_URL || new URL(req.url).origin;
  return NextResponse.redirect(new URL(target, base), 302);
}
