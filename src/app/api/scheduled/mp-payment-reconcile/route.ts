// C-1: MP payment reconciliation cron — catches checkout_pro_link intents
// that stayed "pending" because the MP webhook never arrived.
//
// Runs every 1 minute (schedule: "* * * * *" in scheduler-jobs.json).
// Accepts both GET (manual testing) and POST (Cloud Scheduler).
// Auth: CRON_SECRET bearer or Google-signed OIDC JWT (verifyCronSecret).
//
// Concurrent-run guard: lease-based via CronCheckpoint.runningAt.
// LEASE_TTL = 90 s (cadence 60 s + 30 s grace). A slow run racing its next
// tick is detected by the atomic updateMany; the later instance returns 200
// skipped without touching any payment intent.
// Refs:
//   https://cloud.google.com/scheduler/docs/at-least-once
//   https://cloud.google.com/run/docs/concurrency

import { NextRequest, NextResponse } from "next/server";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { logRouteError, verifyCronSecret } from "@/app/api/_lib/route-helpers";
import { runMpPaymentReconcile } from "./_lib/mp-payment-reconcile-runner";
import { acquireCronLease, releaseCronLease } from "@/app/api/scheduled/_lib/cron-concurrent-lock";

// 120 s is enough for BATCH_LIMIT=100 × ~2 s per MP API call at CONCURRENCY=5.
export const maxDuration = 120;

const CRON_NAME = "mp-payment-reconcile";
// Cadence 60 s + 30 s grace = 90 s. Must be < next tick (60 s) + grace so a
// crashed run doesn't block the following two ticks.
const LEASE_TTL_MS = 90 * 1000;

async function handleRequest(req: NextRequest) {
  const unauth = await verifyCronSecret(req, CRON_NAME);
  if (unauth) return unauth;

  const { acquired } = await acquireCronLease(CRON_NAME, LEASE_TTL_MS);
  if (!acquired) {
    return NextResponse.json({ ok: true, skipped: "lock_held" });
  }

  try {
    const result = await runMpPaymentReconcile();
    return NextResponse.json(result);
  } catch (error) {
    logRouteError("scheduled/mp-payment-reconcile", error);
    return NextResponse.json({ error: "mp-payment-reconcile failed" }, { status: 500 });
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
