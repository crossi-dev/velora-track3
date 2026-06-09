import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeWeekPatternInsight } from "../_lib/planner-day-patterns";
import { cloudLog, runWithTraceContext } from "@/lib/cloud-logger";
import { verifyCronSecret } from "@/app/api/_lib/route-helpers";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";

export const maxDuration = 60;

/**
 * Velora Planner Level 2 — weekly day-of-week pattern analysis.
 * Runs at 03:00 UTC Sunday (00:00 ART). Protected by CRON_SECRET.
 * Requires ≥14 sales in the past 8 weeks to emit an insight.
 */
// GET kept for manual/curl verification; POST is the canonical Cloud Scheduler verb.
export async function GET(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

export async function POST(request: NextRequest) {
  return runWithTraceContext(request.headers, () => handleRequest(request));
}

async function handleRequest(request: NextRequest) {
  const unauth = await verifyCronSecret(request, "week-patterns");
  if (unauth) return unauth;

  // Use Argentina date — UTC date would break idempotency at 21:00 ART (UTC midnight).
  const week = getArgentinaDateString(Date.now());
  const businesses = await prisma.business.findMany({ select: { id: true } });

  // Batch idempotency check: one query for all businesses instead of N findFirst
  // calls (same pattern that low-stock-alert already uses). Source: debt audit C1.
  const expectedIds = businesses.map((b) => `week-patterns-${b.id}-${week}`);
  const existing = await prisma.chatMessage.findMany({
    where: { clientMessageId: { in: expectedIds } },
    select: { clientMessageId: true },
  });
  const existingSet = new Set(existing.map((m) => m.clientMessageId));

  let analyzed = 0;
  let errors = 0;
  for (const biz of businesses) {
    const clientMessageId = `week-patterns-${biz.id}-${week}`;
    if (existingSet.has(clientMessageId)) continue;

    const insight = await computeWeekPatternInsight(biz.id);
    if (!insight) continue;

    try {
      await prisma.chatMessage.create({
        data: { businessId: biz.id, clientMessageId, kind: "reply", source: "manager", text: `Patrón semanal: ${insight}` },
      });
      analyzed++;
    } catch (error) {
      // Per-business isolation: log and continue — one failed write must not abort the rest.
      errors++;
      cloudLog({ severity: "ERROR", component: "System", action: "WEEK_PATTERNS_WRITE_FAILED", a2a_transfer: false, message: "Week pattern chat write failed", businessId: biz.id, data: { error: error instanceof Error ? error.message : String(error) } });
    }
  }

  // Return non-200 if every attempted write failed so Cloud Scheduler retries.
  // Per-business errors still produce 200 (isolation: partial success is acceptable).
  if (analyzed === 0 && errors > 0) {
    cloudLog({ severity: "ERROR", component: "System", action: "WEEK_PATTERNS_ALL_FAILED", a2a_transfer: false, message: `Week patterns: all ${errors} write(s) failed — returning 500 for Scheduler retry`, data: { errors } });
    return NextResponse.json({ ok: false, analyzed, errors }, { status: 500 });
  }
  return NextResponse.json({ ok: true, analyzed, errors });
}
