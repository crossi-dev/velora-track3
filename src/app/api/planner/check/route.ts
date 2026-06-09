import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimit, logRouteError, unauthorized, internalError } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { computePlannerNudges, type PlannerNudge } from "@/app/api/scheduled/_lib/planner-velocity";

// READ-ONLY route. Returns current planner insights for visual rendering in the
// Planner tab "Para hacer" zone and as the data source for the login mount.
//
// Does NOT write to ChatMessage. Chat-side notifications go through
// POST /api/planner/notify (write path) and the scheduled crons. Opening the
// Planner tab any number of times produces zero Manager messages.
//
// weekPatternText is fetched from the most recent stored week-patterns
// ChatMessage rather than re-running the Gemini call (LLM cost + latency
// would otherwise scale with tab opens).

interface PlannerCheckResponse {
  nudges: PlannerNudge[];
  weekPatternText: string | null;
  weekPatternAt: string | null;
}

export async function GET(req: NextRequest) {
  const rateLimited = checkRateLimit(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  try {
    const [nudges, latestPattern] = await Promise.all([
      computePlannerNudges(businessId),
      prisma.chatMessage.findFirst({
        where: {
          businessId,
          source: "manager",
          clientMessageId: { startsWith: "week-patterns-" },
        },
        orderBy: { createdAt: "desc" },
        select: { text: true, createdAt: true },
      }),
    ]);

    const weekPatternText = latestPattern?.text?.replace(/^Patrón semanal:\s*/i, "") ?? null;
    const weekPatternAt = latestPattern?.createdAt?.toISOString() ?? null;

    const response: PlannerCheckResponse = { nudges, weekPatternText, weekPatternAt };
    return NextResponse.json(response);
  } catch (error) {
    logRouteError("planner/check", error);
    return internalError("No se pudo calcular el planner.");
  }
}
