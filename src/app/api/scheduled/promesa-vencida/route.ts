// Cloud Scheduler fires this daily at 09:00 ART (America/Argentina/Mendoza).
// Auth: CRON_SECRET bearer via verifyCronSecret.
// Verb: POST (Cloud Scheduler default, matching httpMethod in scheduler-jobs.json).
//
// Logic: queries PaymentIntents with metodo="promesa" AND estado="confirmed"
// AND promesaExpectedAt < now(), then nudges the owner per business via a
// ChatMessage (owner_only) + push. Idempotent by clientMessageId = "promesa-vencida-{id}-{YYYYMMDD}".

import { NextRequest, NextResponse } from "next/server";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { logRouteError, verifyCronSecret } from "@/app/api/_lib/route-helpers";
import { runPromesaVencidaCron } from "@/app/api/scheduled/_lib/promesa-vencida-cron";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handlePost(req));
}

async function handlePost(req: NextRequest) {
  const unauth = await verifyCronSecret(req, "promesa-vencida");
  if (unauth) return unauth;

  try {
    const result = await runPromesaVencidaCron();

    cloudLog({
      severity: "INFO",
      component: "Payments",
      action: "PROMESA_VENCIDA_DONE",
      a2a_transfer: false,
      message: "promesa-vencida cron complete",
      data: result as unknown as Record<string, unknown>,
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    logRouteError("scheduled/promesa-vencida", error);
    return NextResponse.json({ error: "promesa-vencida failed" }, { status: 500 });
  }
}
