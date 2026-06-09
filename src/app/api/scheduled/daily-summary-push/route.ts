import { NextRequest, NextResponse } from "next/server";
import { runDailySummaryCron } from "@/app/api/scheduled/_lib/daily-summary-cron";
import { logRouteError, verifyCronSecret } from "@/app/api/_lib/route-helpers";
import { runWithTraceContext } from "@/lib/cloud-logger";

export const maxDuration = 60;

// Cloud Scheduler invokes this with POST (the job was created with httpMethod=POST).
// A GET alias is also provided for manual testing / curl invocations.
// Schedule: "0 23 * * *" UTC = 20:00 AR.

async function handleRequest(req: NextRequest) {
  const unauth = await verifyCronSecret(req, "daily-summary-push");
  if (unauth) return unauth;

  try {
    const result = await runDailySummaryCron();
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    logRouteError("scheduled/daily-summary-push", error);
    return NextResponse.json({ error: "Internal" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleRequest(req));
}

export async function POST(req: NextRequest) {
  return runWithTraceContext(req.headers, () => handleRequest(req));
}
