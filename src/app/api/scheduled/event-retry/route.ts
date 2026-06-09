// Accepts both GET (manual testing) and POST (Cloud Scheduler default).
// Auth: CRON_SECRET bearer via verifyCronSecret.
//
// Concurrent-run guard: lease-based via CronCheckpoint.runningAt.
// LEASE_TTL = 4 min (cadence 5 min + 1 min grace). Handlers have varying
// idempotency strength; the lease prevents the most common double-replay
// scenario where a single slow run races its next tick.
// Refs:
//   https://cloud.google.com/scheduler/docs/at-least-once
//   https://cloud.google.com/run/docs/concurrency
import { NextRequest, NextResponse } from "next/server";
import { runEventRetryCron } from "@/app/api/scheduled/_lib/event-retry-cron";
import { logRouteError, verifyCronSecret } from "@/app/api/_lib/route-helpers";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { acquireCronLease, releaseCronLease } from "@/app/api/scheduled/_lib/cron-concurrent-lock";

export const maxDuration = 30;

const CRON_NAME = "event-retry";
// Cadence 5 min + 1 min grace = 4 min lease. Must be < cron period so a
// crashed run doesn't permanently block the next scheduled tick.
const LEASE_TTL_MS = 4 * 60 * 1000;

async function handleRequest(req: NextRequest) {
  const unauth = await verifyCronSecret(req, CRON_NAME);
  if (unauth) return unauth;

  const { acquired } = await acquireCronLease(CRON_NAME, LEASE_TTL_MS);
  if (!acquired) {
    return NextResponse.json({ ok: true, skipped: "lock_held" });
  }

  try {
    const result = await runEventRetryCron();
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    logRouteError("scheduled/event-retry", error);
    return NextResponse.json({ error: "Internal" }, { status: 500 });
  } finally {
    await releaseCronLease(CRON_NAME);
  }
}

export async function GET(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleRequest(req));
}

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleRequest(req));
}
