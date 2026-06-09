import { prisma } from "@/lib/prisma";

const PLANNER_WINDOW_DAYS = 14;
const DEFAULT_LEAD_DAYS = 3;
const DEFAULT_COLD_THRESHOLD = 5;

const DAYS_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

export interface PlannerNudge {
  productName: string;
  daysRemaining: number;
  targetDayLabel: string;
  coldStart?: boolean;
  currentStock?: number;
}

// Canonical 2026 actionable-alert rule (Mixpanel notification best practice +
// Stripe Radar): never alert without a demand signal. A product with zero
// lifetime SaleItems is a catalog entry, not a runout risk — alerting on it
// is noise, not signal. This set lets `computePlannerNudges` skip cold-start
// nudges for products that never sold.
async function computeProductIdsWithLifetimeSales(businessId: string): Promise<Set<string>> {
  const rows: Array<{ productId: string }> = await prisma.$queryRaw`
    SELECT DISTINCT si."productId"
    FROM "SaleItem" si
    JOIN "Sale" s ON si."saleId" = s.id
    WHERE s."businessId" = ${businessId}
      AND si."productId" IS NOT NULL
  `;
  return new Set(rows.map((r) => r.productId));
}

async function computeVelocityMap(businessId: string): Promise<Map<string, number>> {
  const since = new Date();
  since.setDate(since.getDate() - PLANNER_WINDOW_DAYS);

  // Single JOIN aggregation pushed to SQL — replaces a 2-query pattern that
  // loaded every Sale row from the last N days just to extract IDs for a
  // saleItem.groupBy. The previous version had no LIMIT and could OOM a busy
  // tenant. Now the DB does the full work; we only receive the aggregated rows.
  // Supabase pgbouncer transaction mode is happy with bound Date params; no
  // array casts or HAVING-parametrized values involved (those are the patterns
  // that broke post-Supabase migration — see Bug 7 fix on 2026-05-23).
  const rows: Array<{ productId: string; totalSold: bigint | number }> = await prisma.$queryRaw`
    SELECT si."productId", SUM(si.quantity)::int AS "totalSold"
    FROM "SaleItem" si
    JOIN "Sale" s ON si."saleId" = s.id
    WHERE s."businessId" = ${businessId}
      AND s.date >= ${since}
      AND si."productId" IS NOT NULL
    GROUP BY si."productId"
  `;

  const soldMap = new Map<string, number>();
  for (const r of rows) {
    soldMap.set(r.productId, Number(r.totalSold));
  }
  return soldMap;
}

export async function computePlannerNudges(businessId: string): Promise<PlannerNudge[]> {
  const [soldMap, lifetimeSoldSet] = await Promise.all([
    computeVelocityMap(businessId),
    computeProductIdsWithLifetimeSales(businessId),
  ]);

  const products = await prisma.product.findMany({
    where: { businessId },
    select: { id: true, name: true, reorderThreshold: true, quantity: true },
    take: 500, // defensive cap — protects the cron loop from O(n) growth
  });

  const nudges: PlannerNudge[] = [];
  const today = new Date();

  for (const p of products) {
    const currentStock = p.quantity;
    const totalSold = soldMap.get(p.id) ?? 0;
    const dailyAvg = totalSold / PLANNER_WINDOW_DAYS;

    if (dailyAvg === 0) {
      // Cold-start nudge: only fire when (a) stock is at/below threshold AND
      // (b) the product has at least one lifetime SaleItem. Without (b) we have
      // zero demand signal and the alert is noise — see the actionable-alert
      // rule at `computeProductIdsWithLifetimeSales`.
      if (
        currentStock <= (p.reorderThreshold ?? DEFAULT_COLD_THRESHOLD) &&
        lifetimeSoldSet.has(p.id)
      ) {
        nudges.push({ productName: p.name, daysRemaining: 0, targetDayLabel: "", coldStart: true, currentStock });
      }
      continue;
    }

    const daysRemaining = currentStock / dailyAvg;
    if (daysRemaining >= DEFAULT_LEAD_DAYS) continue;

    const targetDate = new Date(today);
    targetDate.setDate(today.getDate() + Math.round(daysRemaining));
    nudges.push({ productName: p.name, daysRemaining, targetDayLabel: DAYS_ES[targetDate.getDay()] });
  }

  return nudges;
}

export function buildPlannerNudgeText(nudge: PlannerNudge): string {
  if (nudge.coldStart) {
    return `${nudge.productName} tiene solo ${nudge.currentStock ?? 0}u. en stock (sin historial de ventas aún).`;
  }
  return `A este ritmo te quedás sin ${nudge.productName} el ${nudge.targetDayLabel}.`;
}
