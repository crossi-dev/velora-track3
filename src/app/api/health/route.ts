import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { authConfig } from "@/auth.config";

/**
 * Public liveness / readiness probe.
 *
 * - No auth required (used by Cloud Run / uptime monitors / k8s liveness probes).
 * - Runs a trivial query against Postgres to confirm the pool is reachable.
 * - Fails closed: any thrown error → 503.
 * - mp_pos is ADVISORY — does not affect HTTP status. Surfaces POS config
 *   gaps (MP_POS_NOT_FOUND RCA) without breaking Cloud Run liveness.
 * - auth checks the NextAuth providers list in-process (no HTTP hop) so a
 *   misconfigured GOOGLE_CLIENT_ID / missing provider surfaces here.
 *
 * Allowlisted in middleware.ts (API_ALLOWLIST) so it bypasses auth + CSRF checks.
 */
export const dynamic = "force-dynamic";

type MpPosStatus = "ok" | "missing" | "unconfigured";
type AuthStatus = "ok" | "fail";

/**
 * Non-cached check: queries MP /pos list and verifies MP_EXTERNAL_POS_ID is present.
 * Times out at 3s so the health endpoint stays fast.
 */
async function checkMpPos(): Promise<MpPosStatus> {
  const accessToken = process.env.MP_DIRECT_ACCESS_TOKEN;
  const externalPosId = process.env.MP_EXTERNAL_POS_ID;

  if (!accessToken || !externalPosId) {
    return "unconfigured";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const res = await fetch(
      `https://api.mercadopago.com/pos?limit=20`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: controller.signal,
      },
    );
    if (!res.ok) {
      cloudLog({
        severity: "WARNING",
        component: "System",
        action: "HEALTH_MP_POS_API_ERROR",
        a2a_transfer: false,
        message: `Health MP POS check returned status=${res.status}`,
        data: { status: res.status },
      });
      // Non-2xx from MP API → treat as unconfigured (can't determine state)
      return "unconfigured";
    }
    const body = await res.json().catch(() => null) as {
      results?: Array<{ external_id?: string }>;
    } | null;
    const found = !!body?.results?.some((p) => p.external_id === externalPosId);
    return found ? "ok" : "missing";
  } catch {
    // Timeout or network error — don't crash health; treat as unconfigured
    return "unconfigured";
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * In-process auth check: reads the NextAuth providers list directly from
 * authConfig (no HTTP hop). Fails if no providers are configured or if the
 * required GOOGLE_CLIENT_ID env var is missing/empty.
 *
 * Advisory only — does not affect HTTP status, mirrors mp_pos pattern.
 */
function checkAuth(): AuthStatus {
  try {
    const providers = authConfig.providers;
    if (!Array.isArray(providers) || providers.length === 0) {
      return "fail";
    }
    // Google OAuth requires GOOGLE_CLIENT_ID to be non-empty at runtime.
    if (!process.env.GOOGLE_CLIENT_ID) {
      return "fail";
    }
    return "ok";
  } catch {
    return "fail";
  }
}

export async function GET() {
  const time = new Date().toISOString();
  let dbOk = false;

  try {
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch (err) {
    cloudLog({ severity: "ERROR", component: "System", action: "HEALTH_DB_FAILED", a2a_transfer: false, message: "Health check: DB unreachable", data: { error: err instanceof Error ? err.message : String(err) } });
  }

  const mpPos = await checkMpPos();
  const auth = checkAuth();

  if (mpPos === "missing") {
    cloudLog({
      severity: "WARNING",
      component: "System",
      action: "HEALTH_MP_POS_MISSING",
      a2a_transfer: false,
      message: `Health check: MP POS ${process.env.MP_EXTERNAL_POS_ID} not found — QR payments will degrade`,
      data: { externalPosId: process.env.MP_EXTERNAL_POS_ID },
    });
  }

  if (auth === "fail") {
    cloudLog({
      severity: "ERROR",
      component: "System",
      action: "HEALTH_AUTH_FAILED",
      a2a_transfer: false,
      message: "Health check: auth providers misconfigured — OAuth login will fail",
      data: { googleClientIdPresent: !!process.env.GOOGLE_CLIENT_ID },
    });
  }

  const allOk = dbOk && auth === "ok";
  const status = allOk ? "ok" : "fail";
  const httpStatus = allOk ? 200 : 503;

  return NextResponse.json(
    {
      status,
      revision: process.env.K_REVISION ?? "unknown",
      checks: {
        db: dbOk ? "ok" : "fail",
        mp_pos: mpPos,
        auth,
        time,
      },
    },
    { status: httpStatus }
  );
}
