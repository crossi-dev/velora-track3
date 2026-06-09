import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { logRouteError, verifyCronSecret } from "@/app/api/_lib/route-helpers";
import { prisma } from "@/lib/prisma";

export const maxDuration = 60;

/**
 * Monthly cleanup — deletes push subscriptions that have been marked expired
 * for at least 90 days. Fired by Cloud Scheduler velora-push-cleanup on the
 * 1st of each month at 07:00 UTC (04:00 ART).
 *
 * The daily audit-cleanup cron marks rows expired=true within 30 days of their
 * last heartbeat; this job removes those tombstones after 90 days so the table
 * doesn't grow unboundedly.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

// GET kept for manual/curl verification; POST is the canonical Cloud Scheduler verb.
export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "push-cleanup");
  if (unauth) return unauth;

  const startedAt = Date.now();
  const cutoff90 = new Date(startedAt - 90 * DAY_MS);

  try {
    const deleted = await prisma.pushSubscription.deleteMany({
      where: {
        expired: true,
        updatedAt: { lt: cutoff90 },
      },
    });

    const durationMs = Date.now() - startedAt;

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "PUSH_CLEANUP_COMPLETED",
      a2a_transfer: false,
      message: "Monthly push subscription cleanup completed",
      businessId: "",
      data: { deleted: deleted.count, cutoff90: cutoff90.toISOString(), durationMs },
    });

    return NextResponse.json({ ok: true, deleted: deleted.count, durationMs });
  } catch (error) {
    logRouteError("scheduled/push-cleanup", error);
    return NextResponse.json({ error: "push-cleanup failed" }, { status: 500 });
  }
}
