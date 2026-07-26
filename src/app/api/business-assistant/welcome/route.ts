import { type NextRequest, NextResponse } from "next/server";
import { resolveActor } from "@/app/api/_lib/resolve-actor";
import { unauthorized, checkRateLimit } from "@/app/api/_lib/route-helpers";
import { loadSupervisorContext } from "@/app/api/supervisor/_lib/load-context";
import { prisma } from "@/lib/prisma";
import { formatMoney } from "@/app/api/business-assistant/_lib/shared";
import { getArgentinaDayBounds } from "@/app/dashboard/lib/today-summary";

interface ReturningOwnerSnapshot {
  todaySaleCount: number;
  todayRevenue: number;
  lowStockCount: number;
  currency: string;
}

async function fetchReturningOwnerSnapshot(businessId: string): Promise<ReturningOwnerSnapshot> {
  const { startMs, endMs } = getArgentinaDayBounds(Date.now());
  const todayStart = new Date(startMs);
  const todayEnd = new Date(endMs);

  const [supCtx, todayAgg] = await Promise.all([
    loadSupervisorContext(businessId),
    prisma.sale.aggregate({
      where: { businessId, date: { gte: todayStart, lte: todayEnd } },
      _sum: { totalAmount: true },
      _count: { id: true },
    }),
  ]);

  return {
    todaySaleCount: todayAgg._count.id,
    todayRevenue: Number(todayAgg._sum.totalAmount ?? 0),
    lowStockCount: supCtx.productsWithoutStock,
    currency: supCtx.currency,
  };
}

function buildReturningOwnerNudge(snap: ReturningOwnerSnapshot): string {
  const parts: string[] = [];

  if (snap.todaySaleCount > 0) {
    const revenueLabel = formatMoney(snap.todayRevenue, snap.currency, "es-AR");
    parts.push(
      snap.todaySaleCount === 1
        ? `Hoy tenés 1 venta registrada por ${revenueLabel}.`
        : `Hoy tenés ${snap.todaySaleCount} ventas por ${revenueLabel}.`,
    );
  }

  if (snap.lowStockCount > 0) {
    parts.push(
      snap.lowStockCount === 1
        ? "1 producto sin stock."
        : `${snap.lowStockCount} productos sin stock.`,
    );
  }

  if (parts.length === 0) {
    return "¿Cómo arrancamos el día? Decime qué vendiste o preguntá lo que necesites.";
  }

  return parts.join(" ");
}

export async function GET(req: NextRequest) {
  const rateLimited = checkRateLimit(req, "ai", 30, 60);
  if (rateLimited) return rateLimited;

  const actor = await resolveActor(req);
  if (!actor) {
    return unauthorized();
  }

  // Employee PIN-login removed (0 rows in production, Stage 1 cleanup) —
  // actor.actorEmployeeId is always null now.

  // Owner branch: day-0 T1 greeting is owned by the DB seed in
  // chat-history/route.ts (maybeSeedOnboardingTurn1). 204 (no body) so a stale
  // cached client cannot parse a greeting out of this response.
  const ctx = await loadSupervisorContext(actor.businessId);
  if (!ctx.businessNameSet) {
    return new NextResponse(null, { status: 204 });
  }

  // Returning owner: emit a situational nudge instead of silence.
  const snap = await fetchReturningOwnerSnapshot(actor.businessId);
  const nudge = buildReturningOwnerNudge(snap);
  return NextResponse.json({ message: nudge });
}
