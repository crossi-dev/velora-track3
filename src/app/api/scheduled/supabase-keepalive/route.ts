import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { prisma } from "@/lib/prisma";
import { logRouteError, verifyCronSecret } from "@/app/api/_lib/route-helpers";

export const maxDuration = 60;

/**
 * Supabase free-tier auto-pause keepalive — daily.
 *
 * Supabase Free pauses the ENTIRE project after 7 consecutive days with zero
 * database traffic. That is a full outage: silent, total denial of service —
 * the same failure class as a connection-exhaustion incident, but triggered by
 * inactivity instead of load. A single lightweight query per day keeps the
 * project active and defeats the auto-pause timer regardless of whether other
 * traffic happens to reach the DB.
 *
 * Deliberately minimal: one `SELECT 1` round-trip. No table access, no writes,
 * no transaction — the only goal is to register DB activity.
 *
 * GET is kept for manual/curl verification; POST is the canonical Cloud
 * Scheduler verb (mirrors the audit-cleanup convention).
 */

export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "supabase-keepalive");
  if (unauth) return unauth;

  const startedAt = Date.now();
  try {
    // Minimal DB round-trip — the query result is irrelevant; the point is to
    // produce traffic so Supabase's inactivity auto-pause timer never fires.
    await prisma.$queryRaw`SELECT 1`;
    const durationMs = Date.now() - startedAt;

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "SUPABASE_KEEPALIVE_OK",
      a2a_transfer: false,
      message: "Supabase keepalive ping succeeded",
      businessId: "",
      data: { event: "SUPABASE_KEEPALIVE_OK", durationMs },
    });

    return NextResponse.json({ ok: true, durationMs });
  } catch (error) {
    logRouteError("scheduled/supabase-keepalive", error);
    return NextResponse.json({ error: "keepalive failed" }, { status: 500 });
  }
}
