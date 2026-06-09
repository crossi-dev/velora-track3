import { NextRequest, NextResponse } from "next/server";
import { after } from "next/server";
import { prisma } from "@/lib/prisma";
import { cloudLog } from "@/lib/cloud-logger";
import { checkRateLimit, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { computePlannerNudges, buildPlannerNudgeText } from "@/app/api/scheduled/_lib/planner-velocity";
import { getArgentinaDateString } from "@/app/dashboard/lib/today-summary";

// Velora Manager (Agent 2) — write path for the login trigger.
// Called fire-and-forget from the dashboard mount via usePlannerCheck.
//
// Decision algorithm (executes in order, stops on first action):
//   1. Has the daily cron `low-stock-alert-{businessId}-{today}` already fired?
//      → yes: skip (cron handles today's chat write)
//   2. Are there any planner nudges right now?
//      → no: skip (nothing to notify about)
//   3. Has the login trigger already fired today?
//      → yes: skip (one login-trigger message per day max)
//   4. Write `planner-login-{businessId}-{today}` with current nudges.
//
// Net effect: at most one Manager message from this route per business per day.
// Dedup is enforced by ChatMessage @@unique([businessId, clientMessageId]).

export async function POST(req: NextRequest) {
  // Resolve actor before rate-limit so we can key by businessId instead of IP.
  // IP-based keying breaks on CGNAT mobile networks (multiple businesses share
  // one egress IP) and drains the shared global bucket unfairly.
  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  const rateLimited = checkRateLimit(req, "planner-notify", 10, 60, { actorKey: businessId });
  if (rateLimited) return rateLimited;

  // Use Argentina date — UTC date would break idempotency at 21:00 ART (UTC midnight).
  const today = getArgentinaDateString(Date.now());

  try {
    // Step 1: cron already handled today?
    // The cron writes TWO different clientMessageIds — `low-stock-alert-*` for
    // the low-stock reminder AND `planner-nudge-*` for the "Velora Planner:" nudge.
    // Both must be in the guard or the login-trigger fires a duplicate Planner
    // message on days where there's no low-stock-alert path but there IS a nudge.
    const cronWrote = await prisma.chatMessage.findFirst({
      where: {
        businessId,
        clientMessageId: {
          in: [
            `low-stock-alert-${businessId}-${today}`,
            `planner-nudge-${businessId}-${today}`,
          ],
        },
      },
      select: { id: true },
    });
    if (cronWrote) return NextResponse.json({ ok: true, skipped: "cron-already-fired" });

    // Step 3 (cheap check before computing nudges): login trigger already fired today?
    const loginWrote = await prisma.chatMessage.findFirst({
      where: { businessId, clientMessageId: `planner-login-${businessId}-${today}` },
      select: { id: true },
    });
    if (loginWrote) return NextResponse.json({ ok: true, skipped: "login-already-fired" });

    // Step 2: anything to surface?
    const nudges = await computePlannerNudges(businessId);
    if (nudges.length === 0) return NextResponse.json({ ok: true, skipped: "no-nudges" });

    // Step 4: write.
    const lines = nudges.map(buildPlannerNudgeText).join("\n");
    const text = `Velora Planner:\n${lines}`;
    // Wrap in after() — guarantees execution continuation even under Cloud Run
    // CPU throttle post-response. P2002 (another tab raced us) is silently accepted.
    // Ref: https://nextjs.org/docs/app/api-reference/functions/after
    after(
      prisma.chatMessage.create({
        data: {
          businessId,
          clientMessageId: `planner-login-${businessId}-${today}`,
          kind: "reply",
          source: "manager",
          text,
          visibility: "owner_only",
        },
      }).catch((error: unknown) => {
        const code = (error as { code?: string } | null)?.code;
        if (code !== "P2002") {
          cloudLog({ severity: "ERROR", component: "System", action: "PLANNER_NOTIFY_WRITE_FAILED", a2a_transfer: false, message: "Planner notify chat write failed", businessId, data: { error: error instanceof Error ? error.message : String(error) } });
        }
      })
    );

    return NextResponse.json({ ok: true, written: 1 });
  } catch (error) {
    logRouteError("planner/notify", error);
    return NextResponse.json({ code: "PLANNER_NOTIFY_FAILED", message: "Failed to create planner notification." }, { status: 500 });
  }
}
