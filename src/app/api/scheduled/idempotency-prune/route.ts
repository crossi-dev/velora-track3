import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { logRouteError, verifyCronSecret } from "@/app/api/_lib/route-helpers";
import { cleanStuckPendingIdempotencyRecords } from "../audit-cleanup/_lib/audit-cleanup";

export const maxDuration = 60;

/**
 * Frequent idempotency prune — every 5 minutes (every-5-min cron).
 *
 * Fixes M-1 finding: the daily audit-cleanup cron (velora-audit-cleanup at
 * 04:00 UTC) was the ONLY place that called cleanStuckPendingIdempotencyRecords,
 * meaning a stuck pending row could block AFIP emit retries for up to ~24h.
 *
 * This dedicated cron runs the same 5-min TTL prune on the frequent cadence
 * that the original per-request pruning (removed from beginIdempotentMutation
 * to avoid per-call DB overhead) was designed to match.
 *
 * The daily audit-cleanup also continues to call cleanStuckPendingIdempotencyRecords
 * as a belt-and-suspenders fallback — no change to that path.
 */

async function handleRequest(req: NextRequest) {
  const unauth = await verifyCronSecret(req, "idempotency-prune");
  if (unauth) return unauth;

  const startedAt = Date.now();

  try {
    const deleted = await cleanStuckPendingIdempotencyRecords(startedAt);

    cloudLog({
      severity: "INFO",
      component: "System",
      action: "IDEMPOTENCY_PRUNE_COMPLETED",
      a2a_transfer: false,
      message: "Idempotency prune completed",
      data: { deleted, durationMs: Date.now() - startedAt },
    });

    return NextResponse.json({ ok: true, deleted, durationMs: Date.now() - startedAt });
  } catch (error) {
    logRouteError("scheduled/idempotency-prune", error);
    return NextResponse.json({ code: "INTERNAL_ERROR", message: "idempotency-prune failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleRequest(req));
}

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleRequest(req));
}
