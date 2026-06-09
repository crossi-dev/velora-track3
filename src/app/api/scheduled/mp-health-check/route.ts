import { NextRequest, NextResponse } from "next/server";
import { runWithTraceContext } from "@/lib/cloud-logger";
import { logRouteError, verifyCronSecret } from "@/app/api/_lib/route-helpers";
import { runMpHealthCheck } from "./_lib/mp-health-check-runner";

export const maxDuration = 120;

// Cloud Scheduler: "0 12 * * *" UTC = 09:00 ART.
// Accepts both GET (manual testing) and POST (Cloud Scheduler).

async function handleRequest(req: NextRequest) {
  const unauth = await verifyCronSecret(req, "mp-health-check");
  if (unauth) return unauth;

  try {
    const result = await runMpHealthCheck();
    return NextResponse.json(result);
  } catch (error) {
    logRouteError("scheduled/mp-health-check", error);
    return NextResponse.json({ error: "mp-health-check failed" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleRequest(req));
}

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleRequest(req));
}
