import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { checkRateLimitExpensive, logRouteError, unauthorized } from "@/app/api/_lib/route-helpers";
import { resolveActor, requireRole } from "@/app/api/_lib/resolve-actor";
import { buildActiveProductWhere } from "@/infrastructure/shared/product-sku";

export async function GET(req: NextRequest) {
  // Expensive: two Prisma queries, groupBy aggregation — strict limit.
  const rateLimited = checkRateLimitExpensive(req);
  if (rateLimited) return rateLimited;

  const ctx = await resolveActor(req);
  if (!ctx) return unauthorized();
  const forbidden = requireRole(ctx, ["owner"]);
  if (forbidden) return forbidden;
  const { businessId } = ctx;

  const url = new URL(req.url);
  const rawDays = Number(url.searchParams.get("days") ?? "14");
  const days = rawDays === 30 ? 30 : 14;

  const since = new Date();
  since.setDate(since.getDate() - days);

  try {
    const recentSaleIds = await prisma.sale.findMany({
      where: { businessId, date: { gte: since } },
      select: { id: true },
      take: 1000,
    });
    const saleIds = recentSaleIds.map((s) => s.id);

    const soldMap = new Map<string, number>();
    if (saleIds.length > 0) {
      const agg = await prisma.saleItem.groupBy({
        by: ["productId"],
        where: { saleId: { in: saleIds } },
        _sum: { quantity: true },
      });
      for (const row of agg) {
        if (row.productId !== null) soldMap.set(row.productId, row._sum.quantity ?? 0);
      }
    }

    const products = await prisma.product.findMany({
      where: buildActiveProductWhere({ businessId }),
      select: {
        id: true,
        name: true,
        reorderThreshold: true,
        quantity: true,
      },
      take: 1000,
    });

    return NextResponse.json(
      products.map((p) => {
        const totalSold = soldMap.get(p.id) ?? 0;
        const dailyAvg = totalSold / days;
        const currentStock = p.quantity;
        const daysRemaining = dailyAvg === 0 ? Infinity : currentStock / dailyAvg;
        return {
          productId: p.id,
          productName: p.name,
          reorderThreshold: p.reorderThreshold ?? 5,
          currentStock,
          totalSold,
          dailyAvg,
          daysRemaining,
        };
      })
    );
  } catch (error) {
    logRouteError("analytics/product-velocity", error);
    return NextResponse.json(
      { error: "No se pudo calcular la velocidad de productos." },
      { status: 500 }
    );
  }
}
