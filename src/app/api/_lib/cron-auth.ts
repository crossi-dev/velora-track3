// Cron / Cloud Scheduler authentication helper.
//
// Two modes, tried in order on every request:
//   1. **OIDC** (preferred): Cloud Scheduler is configured with
//      --oidc-service-account-email=<scheduler-sa> --oidc-token-audience=<cloud-run-url>.
//      Each request carries a short-lived Google-signed JWT that we verify
//      against Google's JWKs with audience + issuer checks.
//   2. **Bearer secret** (back-compat): legacy CRON_SECRET shared secret.
//      Kept enabled during migration so a partially-rolled-out scheduler
//      config still authenticates.
//
// Audit Q4 strict: OIDC is the Google-recommended path; the bearer fallback
// is deprecated and should be removed once all 10 Cloud Scheduler jobs are
// migrated. Mode used per-request is logged at INFO so we can confirm
// migration progress in Cloud Logging before disabling the fallback.

import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { OAuth2Client } from "google-auth-library";
import { cloudLog } from "@/lib/cloud-logger";

// Google's OIDC issuer for ID tokens minted by service accounts.
const GOOGLE_OIDC_ISSUERS = new Set([
  "https://accounts.google.com",
  "accounts.google.com",
]);

// Shared OAuth2Client — caches Google's JWKs so subsequent verifications
// don't re-fetch.
const oauthClient = new OAuth2Client();

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  // timingSafeEqual requires equal-length buffers; unequal lengths are
  // structurally different secrets — reject immediately (no secret info leaked
  // by the length comparison since CRON_SECRET length is not a secret).
  // Pattern mirrors employee-auth.ts (verifyEmployeeSession length guard).
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function looksLikeJwt(token: string): boolean {
  // JWT = three base64url segments separated by dots. The shared bearer
  // secret has no dots, so this cleanly distinguishes the two paths.
  const parts = token.split(".");
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

function getExpectedAudience(): string | null {
  const explicit = (process.env.CLOUD_RUN_AUDIENCE ?? "").trim();
  if (explicit) return explicit;
  const nextauth = (process.env.NEXTAUTH_URL ?? "").trim();
  return nextauth || null;
}

function getAllowedSchedulerEmail(): string | null {
  const v = (process.env.CLOUD_SCHEDULER_SA_EMAIL ?? "").trim();
  return v || null;
}

async function verifyOidcToken(token: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const audience = getExpectedAudience();
  if (!audience) return { ok: false, reason: "no_audience_configured" };
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload) return { ok: false, reason: "no_payload" };
    if (!payload.iss || !GOOGLE_OIDC_ISSUERS.has(payload.iss)) {
      return { ok: false, reason: `bad_issuer:${payload.iss}` };
    }
    const allowedEmail = getAllowedSchedulerEmail();
    // Fail-closed: when CLOUD_SCHEDULER_SA_EMAIL is unset we cannot pin the
    // caller to a known service account. Accepting any Google-signed token for
    // the audience would let ANY GCP service account authenticate as a cron
    // caller. Fall through to the bearer-secret path instead.
    if (!allowedEmail) {
      return { ok: false, reason: "oidc_sa_email_not_configured" };
    }
    if (!payload.email || payload.email !== allowedEmail) {
      return { ok: false, reason: "email_mismatch" };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : "verify_failed" };
  }
}

/**
 * Verifies a cron / scheduled-route request. Tries OIDC first (preferred);
 * if the header carries a raw bearer secret instead, falls back to
 * timing-safe comparison against `CRON_SECRET`.
 *
 * Returns `null` on success; otherwise a 401 NextResponse.
 */
export async function verifyCronAuth(req: NextRequest, scope: string): Promise<NextResponse | null> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }

  if (looksLikeJwt(token)) {
    const oidcResult = await verifyOidcToken(token);
    if (oidcResult.ok) {
      cloudLog({
        severity: "INFO", component: "System", action: "CRON_AUTH_OIDC_OK",
        a2a_transfer: false,
        message: `cron auth via OIDC token (${scope})`,
        data: { scope, mode: "oidc" },
      });
      return null;
    }
    // OIDC validation failed — log the reason but fall through to the bearer
    // secret comparison. A CRON_SECRET that contains dots would look like a JWT
    // to looksLikeJwt(); hard-returning here would permanently reject it.
    // Only return 401 if BOTH paths fail (see below).
    cloudLog({
      severity: "WARNING", component: "System", action: "CRON_AUTH_OIDC_REJECTED",
      a2a_transfer: false,
      message: `cron auth OIDC validation failed, falling through to bearer secret (${scope})`,
      data: { scope, reason: oidcResult.reason },
    });
  }

  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }
  if (!timingSafeEqualString(token, expected)) {
    return NextResponse.json({ code: "UNAUTHORIZED", message: "Authentication required." }, { status: 401 });
  }
  cloudLog({
    severity: "INFO", component: "System", action: "CRON_AUTH_BEARER_OK",
    a2a_transfer: false,
    message: `cron auth via bearer secret fallback (${scope}) — migrate scheduler to OIDC`,
    data: { scope, mode: "bearer_fallback" },
  });
  return null;
}
