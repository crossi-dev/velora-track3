import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { bypassIfTester, checkRateLimit, logRouteError, unauthorized, internalError } from "@/app/api/_lib/route-helpers";
import { resolveActor } from "@/app/api/_lib/resolve-actor";

function toBoundedLimit(raw: string | null) {
  const parsed = Number(raw ?? "120");
  if (!Number.isFinite(parsed)) return 120;
  const rounded = Math.floor(parsed);
  return Math.max(1, Math.min(200, rounded));
}

export async function GET(req: NextRequest) {
  const actor = await resolveActor(req);
  if (!actor) {
    return unauthorized();
  }
  if (actor.role !== "owner") {
    return NextResponse.json({ code: "FORBIDDEN", message: "Solo el dueño puede acceder a esto." }, { status: 403 });
  }

  const rateLimited = checkRateLimit(req, undefined, undefined, undefined, bypassIfTester(actor));
  if (rateLimited) return rateLimited;

  try {
    const limit = toBoundedLimit(req.nextUrl.searchParams.get("limit"));
    const rows = await prisma.criticalWriteEvent.findMany({
      where: {
        businessId: actor.businessId,
        // Exclude chat-history audit noise — these are operational traces,
        // not business events the user should see in chat
        actionType: { notIn: ["chat-history.append", "chat-history.clear", "chat-history.reset"] },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        actionType: true,
        summary: true,
        createdAt: true,
      },
    });

    const response = NextResponse.json({
      events: rows.reverse().map((row) => ({
        id: row.id,
        source: "durable",
        actionType: row.actionType,
        summary: row.summary,
        createdAt: row.createdAt.toISOString(),
      })),
    });
    response.headers.set("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
    return response;
  } catch (error) {
    logRouteError("chat-trace", error);
    return internalError("No se pudo cargar la traza de acciones.");
  }
}
